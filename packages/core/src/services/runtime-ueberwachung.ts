/**
 * P22-T58 (W2e): Ueberwachung der Runtime-Container durch die API (User 59995e5d: Steuerung in der API, Prozesshalter im
 * Container). Vertrag thought c1173508 + Nachtrag 5045840e. Der Container-Daemon trifft keine eigenen Entscheidungen; die API
 * beobachtet, erkennt Ausfaelle und startet neu. Stufe 4 (Nachtrag 2, thought 561ef899, User 9faa5c9f): KETTE fuer ALLE
 * Agenten des ausgefallenen Containers: Fencing (driver.stop), Umzug Claude -> Codex -> Free (Free nur mit registriertem
 * Free-Ausfuehrer, W6/T41), Ausweis und Profil bleiben; Wiederbelebung des angehaltenen Containers und automatische Rueckkehr,
 * sobald das Abo wieder 'ok' ist (nie mitten in Arbeit). CLI-Update entscheidet die API (fuehreCliUpdatesAus), IMMER AN und
 * unabhaengig vom Schalter runtime_ueberwachung (P22-T60, User 90b05805): Steuerung nur ueber die Einstellung cli_update_automatisch.
 * KONTINGENT (Koordinator 20.10.): meldet ein Wrapper ein erschoepftes Abo (Claude stream-json rate_limit_event status
 * 'rejected' mit resetsAt, Codex Usage-Limit-Fehler), gilt die Runtime bis zur Reset-Zeit als 'erschoepft': Kette OHNE Fencing
 * (stop-Job auf der alten Runtime, dann spawn auf dem Ziel), Rueckkehr nach der Reset-Zeit (meldeRuntimeKontingent).
 *
 * SIGNALE je Runtime (claude|codex; free-pool hat keinen Container):
 *   S1 Container (docker inspect, ohne die teuren exec-Proben aus probeStatus) – liefert die rest-api (UeberwachungsDienste).
 *   S2 Prozess: 'synapse-runtime status' im Container mit Zeitlimit (status.json, alle 30 s geschrieben); Timeout = haengt,
 *      fehlende/alte Datei = daemon_tot. Alte Images ohne Runtime-Daemon: prozess 'unbekannt' (nur Containerebene).
 *   S3 API-Verbindung: runtimeDaemonAngemeldet (P22-T5, Zugang aktiv + last_used juenger als daemon_frisch).
 *   S4 Wrapper des Hauptagenten (nur Main-Runtime, Schalter hauptagent EIN): Respawn nur, wenn er zuletzt lief
 *      (main_laeuft_seit) und seitdem kein stop-Auftrag kam; kein Eingriff bei offenen Auftraegen der Main-Identitaet.
 *   S5 ACKs: Auftrag der Main-Identitaet 'claimed' ohne 'accepted' laenger als ack_frist -> Hinweis ack_haengt.
 * MASSNAHMEN: wrapper_respawn (stelleMainLaufSicher), container_restart (docker restart), container_start (driver.start, legt
 *   einen fehlenden Container nach U4-Spezifikation an). Gestoppte Container werden nur gestartet, wenn sie laufen SOLLEN
 *   (container_soll_laufen: einmal laufend gesehen und nicht vom User angehalten). Versuche je Fenster begrenzt, zwischen zwei
 *   Versuchen Erholungszeit; ausgeschoepft -> zustand 'ausgefallen' (+ Befund failover_faellig fuer die Main-Runtime).
 * EINE INSTANZ handelt: pg_try_advisory_lock je Takt (Deploy-Ueberlappung zweier APIs).
 *
 * SCHALTER 'runtime_ueberwachung' (Produkt-Schalter I im Katalog PROFIL_PRODUKT_FUNKTIONEN, Standard AUS, nur ausdruecklich):
 *   wirksam = intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (ebene global) > AUS. Setzen ueber admin
 *   profil_schalter_setzen (User und Koordinator, wie P22-T57). AUS = Altverhalten: keine Probe, keine Massnahme.
 * EINSTELLUNGEN (runtime_ueberwachung_einstellungen, Regel 7): Code-Standard + PG-Wert, Antwort nennt die Quelle. Setzen: User und
 *   Koordinator (User 20.10. F6). Eine Lesestelle: leseRuntimeUeberwachungEinstellungen.
 * DEBUG: admin runtime_ueberwachung modus status (Stand, Ereignisse, Einstellungen, letzter Takt) | takt_trocken (nur bewerten)
 *   | takt_jetzt. Keine Geheimnisse in Ereignissen.
 */
import type { PoolClient, QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter, setzeProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, pflichtText, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';
import { leseHauptagentSchalter, hauptagentIdentitaetsId } from './hauptagent-dienst.js';
import { leseMainLauf, runtimeDaemonAngemeldet, stelleMainLaufSicher, modellPasstZuRuntime } from './hauptagent-lauf.js';
import { enqueueSpecialistJob } from './specialist-queue.js';
import { RUNTIME_PROJEKTE_WURZEL, runtimeProjektPfad } from './runtime-daemon-zugang.js';
import { randomUUID } from 'node:crypto';
import { pruefeModellFuerRuntime } from './hauptagent-modelle.js';

export const RUNTIME_UEBERWACHUNG_FUNKTION = 'runtime_ueberwachung' as const;
export const UEBERWACHTE_RUNTIMES = ['claude', 'codex'] as const;
export type UeberwachteRuntime = typeof UEBERWACHTE_RUNTIMES[number];

type Q = QueryConfig & { query_timeout: number };
type Db = Pick<PoolClient, 'query'>;
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export interface RuntimeUeberwachungSchalter {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  bis: string | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
}

/** Frisch je Aufruf (kein Cache). Lesefehler -> AUS mit letzter_fehler. */
export async function leseRuntimeUeberwachungSchalter(): Promise<RuntimeUeberwachungSchalter> {
  const basis: RuntimeUeberwachungSchalter = { aktiv: false, quelle: 'standard', bis: null, gesetzt_von: null, gesetzt_am: null, grund: null, letzter_fehler: null };
  let letzter: string | null = null;
  // Dynamisch: intern-tool liegt im Importgraph von intern-schalter -> agent-bezug -> ... -> agent-profil-admin (Zyklus).
  const { internToolAktiv } = await import('./intern-tool.js');
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [RUNTIME_UEBERWACHUNG_FUNKTION], query_timeout: 2000,
      } as Q);
      const z = r.rows[0];
      if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
    } catch { letzter = 'schalter_nicht_erreichbar'; }
  }
  const p = await leseProfilProduktSchalter(RUNTIME_UEBERWACHUNG_FUNKTION, null);
  if (p.quelle === 'produkt-schalter') {
    return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter', gesetzt_von: p.gesetzt_von, gesetzt_am: p.gesetzt_am, grund: p.grund, letzter_fehler: letzter };
  }
  return { ...basis, letzter_fehler: letzter ?? p.letzter_fehler };
}

/**
 * P22-T64: Schalter 'runtime_status_stabil' (Produkt-Schalter I, Standard AUS, nur ausdruecklich) samt Einstellwerten.
 * EIN: ein haengender/fehlgeschlagener Status-Probe-Lauf wirft einen bestaetigten guten Anmeldestand nicht um (rest-api
 * status-stabil.ts). Wirksam = intern-Override > Produkt-Schalter global > AUS. Frisch je Aufruf; Lesefehler -> AUS.
 */
export async function leseRuntimeStatusStabil(): Promise<{ aktiv: boolean; quelle: 'standard' | 'produkt-schalter' | 'intern'; negativ_bestaetigung: number;
  guter_stand_minuten: number; letzter_fehler: string | null }> {
  const w = await leseRuntimeUeberwachungWerte();
  const basis = { aktiv: false, quelle: 'standard' as 'standard' | 'produkt-schalter' | 'intern', negativ_bestaetigung: w.status_negativ_bestaetigung,
    guter_stand_minuten: w.status_guter_stand_minuten, letzter_fehler: null as string | null };
  const { internToolAktiv } = await import('./intern-tool.js');
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean }>({
        text: `SELECT aktiv FROM intern_schalter WHERE name = 'runtime_status_stabil' AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [], query_timeout: 2000,
      } as Q);
      if (r.rows[0]) return { ...basis, aktiv: r.rows[0].aktiv, quelle: 'intern' };
    } catch { basis.letzter_fehler = 'schalter_nicht_erreichbar'; }
  }
  try {
    const p = await leseProfilProduktSchalter('runtime_status_stabil', null);
    if (p.quelle === 'produkt-schalter') return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter' };
    return { ...basis, letzter_fehler: basis.letzter_fehler ?? p.letzter_fehler };
  } catch { return { ...basis, letzter_fehler: 'produkt_schalter_nicht_lesbar' }; }
}

/** REST-Weg der Web-UI (User, ebene global). Gleicher Speicher wie admin profil_schalter_setzen (dort auch Koordinatoren). */
export async function setzeRuntimeUeberwachungSchalter(akteur: AusweisAkteur | null, e: { aktiv: unknown; grund: unknown }): Promise<RuntimeUeberwachungSchalter> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Dieser Weg ist der User-Eingang; Koordinatoren nutzen admin profil_schalter_setzen' });
  if (typeof e.aktiv !== 'boolean') fehler('aktiv_fehlt');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  await setzeProfilProduktSchalter({ ebene: 'global', funktion: RUNTIME_UEBERWACHUNG_FUNKTION, aktiv: e.aktiv, grund }, { system: 'user' });
  return leseRuntimeUeberwachungSchalter();
}

// ---------------------------------------------------------------------------------------------
// Einstellungen (Regel 7: Code-Standard + PG-Wert, Quelle sichtbar)
// ---------------------------------------------------------------------------------------------
type EinstellungDef =
  | { art: 'zahl'; standard: number; min: number; max: number }
  | { art: 'bool'; standard: boolean }
  | { art: 'liste'; standard: readonly string[]; erlaubt: readonly string[] };

/** Container-Werte = U4-Spezifikation (thought 791212a9 Schritt 2c). */
export const RUNTIME_UEBERWACHUNG_EINSTELLUNGEN = {
  takt_sekunden: { art: 'zahl', standard: 15, min: 5, max: 300 },
  // P22-T113 (Abnahme R6): Takt und Menge der Zustellung ueber den Startort-Daemon (agent-startort-zustellung.ts).
  startort_zustell_takt_sekunden: { art: 'zahl', standard: 5, min: 1, max: 300 },
  startort_zustell_je_takt: { art: 'zahl', standard: 3, min: 1, max: 20 },
  // Muss ueber dem status.json-Takt (30 s) und dem Long-Poll des Daemons (~25 s) liegen.
  daemon_frisch_sekunden: { art: 'zahl', standard: 90, min: 45, max: 900 },
  probe_timeout_sekunden: { art: 'zahl', standard: 10, min: 2, max: 60 },
  ack_frist_sekunden: { art: 'zahl', standard: 120, min: 30, max: 3600 },
  neustart_erlaubt: { art: 'bool', standard: true },
  neustart_versuche: { art: 'zahl', standard: 2, min: 0, max: 10 },
  neustart_fenster_minuten: { art: 'zahl', standard: 10, min: 1, max: 240 },
  erholung_warte_sekunden: { art: 'zahl', standard: 120, min: 15, max: 1800 },
  failover_erlaubt: { art: 'bool', standard: true },
  failover_reihenfolge: { art: 'liste', standard: ['claude', 'codex', 'free-pool'], erlaubt: ['claude', 'codex', 'free-pool'] },
  // F2 (User 9faa5c9f): automatisch zurueck, sobald das Abo wieder verfuegbar ist.
  zurueck_automatisch: { art: 'bool', standard: true },
  // Fencing (F4) haelt den Container an; ohne Wiederbelebung wuerde das Abo nie wieder verfuegbar (0 = nie).
  wiederbelebung_minuten: { art: 'zahl', standard: 10, min: 0, max: 1440 },
  ereignisse_tage: { art: 'zahl', standard: 30, min: 1, max: 365 },
  container_memory_mb: { art: 'zahl', standard: 2048, min: 512, max: 65536 },
  container_pids_limit: { art: 'zahl', standard: 256, min: 64, max: 4096 },
  container_tmpfs_mb: { art: 'zahl', standard: 256, min: 64, max: 4096 },
  cli_behalten: { art: 'zahl', standard: 4, min: 0, max: 50 },
  // F5: CLI-Update entscheidet die API (der Container-Daemon startet mit SYNAPSE_RUNTIME_CLI_AUTOUPDATE=0).
  // P22-T60: wirkt auch bei Schalter runtime_ueberwachung AUS (User 90b05805 'Auto-Update immer an').
  cli_update_automatisch: { art: 'bool', standard: true },
  cli_update_stunden: { art: 'zahl', standard: 24, min: 1, max: 720 },
  cli_update_timeout_minuten: { art: 'zahl', standard: 15, min: 1, max: 60 },
  // Kontingent: Meldung 'erschoepft' der Wrapper loest die Kette aus; ohne Reset-Zeit gilt dieses Fenster.
  kontingent_ausloeser: { art: 'bool', standard: true },
  kontingent_ohne_reset_minuten: { art: 'zahl', standard: 60, min: 5, max: 1440 },
  // P22-T64 (Schalter runtime_status_stabil): so viele eindeutige 'nicht angemeldet'-Laeufe in Folge, bevor der Status umschaltet;
  // so lange (Minuten) gilt der letzte bestaetigte gute Stand weiter, wenn Probe-Laeufe haengen oder fehlschlagen.
  status_negativ_bestaetigung: { art: 'zahl', standard: 2, min: 1, max: 10 },
  status_guter_stand_minuten: { art: 'zahl', standard: 10, min: 1, max: 240 },
  // P22-T73 (User 68259fd1): Warteschlange des Main-Chats. War der Main mindestens so lange nicht erreichbar (aelteste wartende
  // Nachricht), gehen alle wartenden Nachrichten als EIN Buendel-Turn; kuerzer = einzeln in Reihenfolge. 0 = immer Buendel.
  warteschlange_buendel_sekunden: { art: 'zahl', standard: 120, min: 0, max: 86400 },
} as const satisfies Record<string, EinstellungDef>;
export type RuntimeUeberwachungEinstellungName = keyof typeof RUNTIME_UEBERWACHUNG_EINSTELLUNGEN;
export const RUNTIME_UEBERWACHUNG_EINSTELLUNG_NAMEN = Object.keys(RUNTIME_UEBERWACHUNG_EINSTELLUNGEN) as RuntimeUeberwachungEinstellungName[];
type WertVon<D> = D extends { art: 'zahl' } ? number : D extends { art: 'bool' } ? boolean : string[];
export type RuntimeUeberwachungWerte = { [K in RuntimeUeberwachungEinstellungName]: WertVon<typeof RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[K]> };
export type RuntimeUeberwachungEinstellungen = {
  [K in RuntimeUeberwachungEinstellungName]: { wert: RuntimeUeberwachungWerte[K]; quelle: 'standard' | 'einstellung'; gesetzt_von: string | null; gesetzt_am: string | null }
};

function pruefeWert(name: RuntimeUeberwachungEinstellungName, wert: unknown): unknown {
  const d: EinstellungDef = RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[name];
  if (d.art === 'zahl') {
    if (typeof wert !== 'number' || !Number.isInteger(wert) || wert < d.min || wert > d.max) fehler('einstellung_ungueltig', { name, min: d.min, max: d.max });
    return wert;
  }
  if (d.art === 'bool') {
    if (typeof wert !== 'boolean') fehler('einstellung_ungueltig', { name, erwartet: 'boolean' });
    return wert;
  }
  if (!Array.isArray(wert) || wert.length === 0 || wert.some(v => typeof v !== 'string' || !d.erlaubt.includes(v)) || new Set(wert).size !== wert.length) {
    fehler('einstellung_ungueltig', { name, erlaubt: d.erlaubt });
  }
  return [...wert as string[]];
}

export async function leseRuntimeUeberwachungEinstellungen(db: Db = getPool()): Promise<RuntimeUeberwachungEinstellungen> {
  const aus = {} as Record<string, { wert: unknown; quelle: 'standard' | 'einstellung'; gesetzt_von: string | null; gesetzt_am: string | null }>;
  for (const n of RUNTIME_UEBERWACHUNG_EINSTELLUNG_NAMEN) {
    const s = RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[n].standard;
    aus[n] = { wert: Array.isArray(s) ? [...s] : s, quelle: 'standard', gesetzt_von: null, gesetzt_am: null };
  }
  const r = await db.query<{ name: string; wert: unknown; gesetzt_von: string; gesetzt_am: Date }>(
    'SELECT name, wert, gesetzt_von, gesetzt_am FROM runtime_ueberwachung_einstellungen');
  for (const z of r.rows) {
    if (!(RUNTIME_UEBERWACHUNG_EINSTELLUNG_NAMEN as string[]).includes(z.name)) continue;
    // Ein ungueltig gespeicherter Wert (z. B. nach Grenzaenderung) faellt still auf den Standard zurueck.
    try { aus[z.name] = { wert: pruefeWert(z.name as RuntimeUeberwachungEinstellungName, z.wert), quelle: 'einstellung', gesetzt_von: z.gesetzt_von, gesetzt_am: z.gesetzt_am.toISOString() }; }
    catch { /* Standard bleibt */ }
  }
  return aus as RuntimeUeberwachungEinstellungen;
}

/** Nur die Werte (fuer Takt und Container-Spezifikation). Lesefehler -> Code-Standard. */
export async function leseRuntimeUeberwachungWerte(db: Db = getPool()): Promise<RuntimeUeberwachungWerte> {
  let e: RuntimeUeberwachungEinstellungen | null = null;
  try { e = await leseRuntimeUeberwachungEinstellungen(db); } catch { e = null; }
  const aus = {} as Record<string, unknown>;
  for (const n of RUNTIME_UEBERWACHUNG_EINSTELLUNG_NAMEN) {
    const s = RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[n].standard;
    aus[n] = e ? e[n].wert : (Array.isArray(s) ? [...s] : s);
  }
  return aus as RuntimeUeberwachungWerte;
}

/** User und Koordinator (F6). werte = {name: wert}; entfernen = Namen, deren PG-Wert entfaellt (Rueckfall Code-Standard). */
export async function setzeRuntimeUeberwachungEinstellungen(
  akteur: AusweisAkteur, project: string | null, e: { werte?: unknown; entfernen?: unknown; grund: unknown },
): Promise<RuntimeUeberwachungEinstellungen> {
  const v = await pruefeProfilVerwalter(akteur, project);
  const grund = pflichtText(e.grund, 'grund_fehlt');
  const werte = e.werte === undefined || e.werte === null ? {} : e.werte;
  if (typeof werte !== 'object' || Array.isArray(werte)) fehler('einstellung_ungueltig');
  const entfernen = e.entfernen === undefined || e.entfernen === null ? [] : e.entfernen;
  if (!Array.isArray(entfernen)) fehler('einstellung_ungueltig');
  const setzen: Array<[string, unknown]> = [];
  for (const [name, wert] of Object.entries(werte as Record<string, unknown>)) {
    if (!(RUNTIME_UEBERWACHUNG_EINSTELLUNG_NAMEN as string[]).includes(name)) fehler('einstellung_unbekannt', { name });
    setzen.push([name, pruefeWert(name as RuntimeUeberwachungEinstellungName, wert)]);
  }
  for (const name of entfernen) {
    if (typeof name !== 'string' || !(RUNTIME_UEBERWACHUNG_EINSTELLUNG_NAMEN as string[]).includes(name)) fehler('einstellung_unbekannt', { name });
  }
  if (setzen.length === 0 && entfernen.length === 0) fehler('einstellung_fehlt');
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    for (const [name, wert] of setzen) {
      await c.query(
        `INSERT INTO runtime_ueberwachung_einstellungen (name, wert, grund, gesetzt_von, setter_identity_id, gesetzt_am)
         VALUES ($1, $2::jsonb, $3, $4, $5, NOW())
         ON CONFLICT (name) DO UPDATE SET wert = EXCLUDED.wert, grund = EXCLUDED.grund, gesetzt_von = EXCLUDED.gesetzt_von,
           setter_identity_id = EXCLUDED.setter_identity_id, gesetzt_am = NOW()`,
        [name, JSON.stringify(wert), grund, v.wer, v.actor_identity_id]);
    }
    if (entfernen.length) await c.query('DELETE FROM runtime_ueberwachung_einstellungen WHERE name = ANY($1::text[])', [entfernen]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    if (err instanceof ProfilVerwaltungFehler) throw err;
    fehler('runtime_ueberwachung_speicher_fehler');
  } finally { c.release(); }
  return leseRuntimeUeberwachungEinstellungen();
}

// ---------------------------------------------------------------------------------------------
// Stand und Ereignisse
// ---------------------------------------------------------------------------------------------
export type UeberwachungZustand = 'unbekannt' | 'ok' | 'gestoert' | 'neustart_laeuft' | 'ausgefallen' | 'abgeloest' | 'angehalten' | 'erschoepft';
export type Massnahme = 'keine' | 'wrapper_respawn' | 'container_restart' | 'container_start' | 'failover_faellig' | 'wiederbelebung';
export interface Versuch { zeit: string; art: Massnahme; ursache: string | null }

export interface UeberwachungStand {
  runtime: UeberwachteRuntime;
  zustand: UeberwachungZustand;
  ursache: string | null;
  seit: string;
  letzter_ok: string | null;
  versuche: Versuch[];
  container_soll_laufen: boolean;
  main_laeuft_seit: string | null;
  beobachtung: Record<string, unknown> | null;
  letzter_fehler: string | null;
  wiederbelebung_letzter: string | null;
  /** Nur lesend im Takt; geschrieben von fuehreCliUpdatesAus. */
  cli_update_am: string | null;
  cli_update_ergebnis: Record<string, unknown> | null;
  /** Abo-Kontingent erschoepft bis (nur lesend im Takt; geschrieben von meldeRuntimeKontingent). */
  kontingent_bis: string | null;
}

function leererStand(runtime: UeberwachteRuntime): UeberwachungStand {
  return { runtime, zustand: 'unbekannt', ursache: null, seit: new Date().toISOString(), letzter_ok: null, versuche: [],
    container_soll_laufen: false, main_laeuft_seit: null, beobachtung: null, letzter_fehler: null, wiederbelebung_letzter: null,
    cli_update_am: null, cli_update_ergebnis: null, kontingent_bis: null };
}

const ISO = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function leseUeberwachungStaende(db: Db = getPool()): Promise<Record<UeberwachteRuntime, UeberwachungStand>> {
  const aus = { claude: leererStand('claude'), codex: leererStand('codex') };
  const r = await db.query<{ runtime: string; zustand: UeberwachungZustand; ursache: string | null; seit: Date; letzter_ok: Date | null; versuche: Versuch[];
    container_soll_laufen: boolean; main_laeuft_seit: Date | null; beobachtung: Record<string, unknown> | null; letzter_fehler: string | null;
    wiederbelebung_letzter: Date | null; cli_update_am: Date | null; cli_update_ergebnis: Record<string, unknown> | null; kontingent_bis: Date | null }>(
    `SELECT runtime, zustand, ursache, seit, letzter_ok, versuche, container_soll_laufen, main_laeuft_seit, beobachtung, letzter_fehler,
            wiederbelebung_letzter, cli_update_am, cli_update_ergebnis, kontingent_bis FROM runtime_ueberwachung_stand`);
  for (const z of r.rows) {
    if (!(UEBERWACHTE_RUNTIMES as readonly string[]).includes(z.runtime)) continue;
    aus[z.runtime as UeberwachteRuntime] = {
      runtime: z.runtime as UeberwachteRuntime, zustand: z.zustand, ursache: z.ursache, seit: z.seit.toISOString(), letzter_ok: ISO(z.letzter_ok),
      versuche: Array.isArray(z.versuche) ? z.versuche : [], container_soll_laufen: z.container_soll_laufen, main_laeuft_seit: ISO(z.main_laeuft_seit),
      beobachtung: z.beobachtung, letzter_fehler: z.letzter_fehler, wiederbelebung_letzter: ISO(z.wiederbelebung_letzter),
      cli_update_am: ISO(z.cli_update_am), cli_update_ergebnis: z.cli_update_ergebnis, kontingent_bis: ISO(z.kontingent_bis),
    };
  }
  return aus;
}

async function schreibeStand(db: Db, s: UeberwachungStand): Promise<void> {
  await db.query(
    `INSERT INTO runtime_ueberwachung_stand (runtime, zustand, ursache, seit, letzter_ok, versuche, container_soll_laufen, main_laeuft_seit, beobachtung,
       letzter_fehler, wiederbelebung_letzter, aktualisiert_am)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,NOW())
     ON CONFLICT (runtime) DO UPDATE SET zustand=EXCLUDED.zustand, ursache=EXCLUDED.ursache, seit=EXCLUDED.seit, letzter_ok=EXCLUDED.letzter_ok,
       versuche=EXCLUDED.versuche, container_soll_laufen=EXCLUDED.container_soll_laufen, main_laeuft_seit=EXCLUDED.main_laeuft_seit,
       beobachtung=EXCLUDED.beobachtung, letzter_fehler=EXCLUDED.letzter_fehler, wiederbelebung_letzter=EXCLUDED.wiederbelebung_letzter, aktualisiert_am=NOW()`,
    [s.runtime, s.zustand, s.ursache, s.seit, s.letzter_ok, JSON.stringify(s.versuche), s.container_soll_laufen, s.main_laeuft_seit,
      s.beobachtung ? JSON.stringify(s.beobachtung) : null, s.letzter_fehler, s.wiederbelebung_letzter]);
}

export interface UeberwachungEreignis { id: string; zeit: string; runtime: string; art: string; ursache: string | null; details: Record<string, unknown> | null; auftrag_id: string | null }

async function schreibeEreignis(db: Db, runtime: string, art: string, ursache: string | null, details?: Record<string, unknown> | null): Promise<void> {
  await db.query('INSERT INTO runtime_ueberwachung_ereignisse (runtime, art, ursache, details) VALUES ($1,$2,$3,$4::jsonb)',
    [runtime, art, ursache, details ? JSON.stringify(details) : null]);
}

export async function leseUeberwachungEreignisse(limit = 20, db: Db = getPool()): Promise<UeberwachungEreignis[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const r = await db.query<{ id: string; zeit: Date; runtime: string; art: string; ursache: string | null; details: Record<string, unknown> | null; auftrag_id: string | null }>(
    'SELECT id::text AS id, zeit, runtime, art, ursache, details, auftrag_id FROM runtime_ueberwachung_ereignisse ORDER BY zeit DESC, id DESC LIMIT $1', [n]);
  return r.rows.map(z => ({ ...z, zeit: z.zeit.toISOString() }));
}

/**
 * User haelt eine Runtime ueber die Steuerung an (driver.stop): die Ueberwachung startet sie dann NICHT wieder.
 * Ein spaeterer manueller Start (laufend beobachtet) setzt container_soll_laufen von selbst zurueck. Wirft nie.
 */
export async function markiereRuntimeAngehalten(runtime: string, von: string): Promise<void> {
  if (!(UEBERWACHTE_RUNTIMES as readonly string[]).includes(runtime)) return;
  try {
    await getPool().query(
      `INSERT INTO runtime_ueberwachung_stand (runtime, zustand, ursache, seit, container_soll_laufen, aktualisiert_am)
       VALUES ($1,'angehalten','vom_user_angehalten',NOW(),FALSE,NOW())
       ON CONFLICT (runtime) DO UPDATE SET zustand='angehalten', ursache='vom_user_angehalten', seit=NOW(), container_soll_laufen=FALSE,
         versuche='[]'::jsonb, aktualisiert_am=NOW()`, [runtime]);
    await schreibeEreignis(getPool(), runtime, 'angehalten', 'vom_user_angehalten', { von });
  } catch (err) {
    console.error('[runtime-ueberwachung] Anhalten nicht vermerkt:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------------------------
// Bewertung (rein, testbar)
// ---------------------------------------------------------------------------------------------
export interface ContainerBeobachtung {
  container: 'nicht_konfiguriert' | 'fehlt' | 'gestoppt' | 'laeuft' | 'restarting' | 'fremd' | 'fehler';
  /** ok | haengt (Status-Probe Zeitlimit) | daemon_tot (status.json fehlt/alt) | unbekannt (kein Runtime-Daemon im Image / nicht laufend) */
  prozess: 'ok' | 'haengt' | 'daemon_tot' | 'unbekannt';
  status_alter_s: number | null;
  image: string | null;
  agent_runtime_image: boolean;
  fehler: string | null;
}

export interface RuntimeBeobachtung extends ContainerBeobachtung {
  api_verbunden: boolean;
  ack_haengt: boolean;
  ist_main: boolean;
  /** Nur Main-Runtime bei Schalter hauptagent EIN; sonst null. */
  main_wrapper: 'laeuft' | 'startet' | 'aus' | null;
  /** Wrapper soll laufen (zuletzt laufend gesehen, kein stop seitdem, kein offener Auftrag). */
  main_soll_laufen: boolean;
  /** Abo-Kontingent laut Wrapper-Meldung erschoepft (bis zur Reset-Zeit) und Ausloeser eingeschaltet. */
  kontingent_erschoepft?: boolean;
}

export interface Entscheidung { zustand: UeberwachungZustand; ursache: string | null; massnahme: Massnahme; hinweis: string | null }

const NEUSTART_MASSNAHMEN: readonly Massnahme[] = ['wrapper_respawn', 'container_restart', 'container_start'];

export function bewerteRuntime(b: RuntimeBeobachtung, s: UeberwachungStand, e: RuntimeUeberwachungWerte, jetzt = Date.now()): Entscheidung {
  const roh = rohEntscheidung(b, s);
  if (!NEUSTART_MASSNAHMEN.includes(roh.massnahme)) return roh;
  if (!e.neustart_erlaubt) return { ...roh, massnahme: 'keine', hinweis: 'neustart_aus' };
  const fensterMs = e.neustart_fenster_minuten * 60_000;
  const imFenster = s.versuche.filter(v => jetzt - Date.parse(v.zeit) < fensterMs);
  const letzter = imFenster.length ? Math.max(...imFenster.map(v => Date.parse(v.zeit))) : null;
  if (letzter !== null && jetzt - letzter < e.erholung_warte_sekunden * 1000) {
    return { zustand: 'neustart_laeuft', ursache: roh.ursache, massnahme: 'keine', hinweis: 'erholung_abwarten' };
  }
  if (imFenster.length >= e.neustart_versuche) {
    // Nachtrag 2 (F3): die Kette gilt fuer alle Agenten des Containers, nicht nur fuer den Main.
    return { zustand: 'ausgefallen', ursache: roh.ursache, massnahme: 'failover_faellig', hinweis: 'neustarts_ausgeschoepft' };
  }
  return roh;
}

function rohEntscheidung(b: RuntimeBeobachtung, s: UeberwachungStand): Entscheidung {
  const e = (zustand: UeberwachungZustand, ursache: string | null, massnahme: Massnahme = 'keine', hinweis: string | null = null): Entscheidung =>
    ({ zustand, ursache, massnahme, hinweis });
  const gesund = b.container === 'laeuft' && (b.prozess === 'ok' || b.prozess === 'unbekannt');
  if (s.zustand === 'abgeloest' && !gesund) return e('abgeloest', s.ursache);
  switch (b.container) {
    case 'nicht_konfiguriert': return e('unbekannt', 'nicht_konfiguriert');
    case 'fremd': return e('gestoert', 'container_fremd', 'keine', 'fremder_container');
    case 'fehler': return e('gestoert', 'docker_fehler');
    case 'restarting': return e('neustart_laeuft', 'container_startet_neu');
    case 'fehlt':
    case 'gestoppt':
      if (!s.container_soll_laufen) return e('angehalten', s.zustand === 'angehalten' ? s.ursache : (b.container === 'fehlt' ? 'container_fehlt' : 'container_gestoppt'));
      return e('gestoert', b.container === 'fehlt' ? 'container_fehlt' : 'container_gestoppt', 'container_start');
    case 'laeuft':
      break;
  }
  if (b.prozess === 'haengt') return e('gestoert', 'daemon_haengt', 'container_restart');
  if (b.prozess === 'daemon_tot') return e('gestoert', 'daemon_tot', 'container_restart');
  // Container gesund, aber das Abo-Kontingent ist erschoepft: Kette ohne Fencing (Container laeuft weiter).
  if (b.kontingent_erschoepft) return e('erschoepft', 'kontingent_erschoepft', 'failover_faellig', 'abo_kontingent');
  if (b.prozess === 'ok' && !b.api_verbunden) return e('gestoert', 'api_getrennt', 'keine', 'zugang_pruefen');
  if (b.ack_haengt) return e('gestoert', 'ack_haengt', 'keine', 'auftrag_ohne_annahme');
  if (b.ist_main && b.main_soll_laufen && b.main_wrapper === 'aus' && (b.prozess === 'unbekannt' || b.api_verbunden)) {
    return e('gestoert', 'wrapper_tot', 'wrapper_respawn');
  }
  return e('ok', null);
}

// ---------------------------------------------------------------------------------------------
// Takt
// ---------------------------------------------------------------------------------------------
export interface UeberwachungsDienste {
  beobachte(runtime: UeberwachteRuntime, o: { probe_timeout_ms: number; daemon_frisch_ms: number }): Promise<ContainerBeobachtung>;
  /** driver.start(): legt einen fehlenden Container nach U4-Spezifikation an und startet ihn. */
  starteContainer(runtime: UeberwachteRuntime): Promise<void>;
  /** docker restart des eigenen Containers (Spezifikation bleibt). */
  neustartContainer(runtime: UeberwachteRuntime): Promise<void>;
  mainRuntime(): Promise<string | null>;
  standardModell(runtime: UeberwachteRuntime): Promise<string>;
  /** Fencing (F4): eigenen Container anhalten (driver.stop). */
  stoppeContainer(runtime: UeberwachteRuntime): Promise<void>;
  /** F5: 'synapse-runtime cli update <cli> latest' im Container (nur Agent-Runtime-Image). */
  cliUpdate(runtime: UeberwachteRuntime, o: { timeout_ms: number }): Promise<{ ok: boolean; exit_code: number | null; ausgabe: string }>;
}

export interface TaktBericht {
  aktiv: boolean;
  trocken: boolean;
  uebersprungen?: 'schalter_aus' | 'andere_instanz' | 'laeuft_schon';
  zeit: string;
  runtimes: Array<{ runtime: UeberwachteRuntime; beobachtung: RuntimeBeobachtung | null; entscheidung: Entscheidung | null; ausgefuehrt: Massnahme | null; fehler: string | null }>;
  /** Kette (Umzuege und Rueckkehr); trocken = nur geplant. */
  kette: KettenSchritt[];
  letzter_fehler: string | null;
}

const SPERRE = 'synapse-runtime-ueberwachung';
let letzterTakt: TaktBericht | null = null;
let taktLaeuft = false;

/** Letzter Bericht dieses Prozesses (Debug). */
export function letzterUeberwachungsTakt(): TaktBericht | null { return letzterTakt; }

async function mainSollLaufen(db: Db, identityId: string, s: UeberwachungStand, wrapper: 'laeuft' | 'startet' | 'aus', jetzt: Date): Promise<{ soll: boolean; laeuft_seit: string | null }> {
  let laeuftSeit = s.main_laeuft_seit;
  if (wrapper === 'laeuft' && !laeuftSeit) laeuftSeit = jetzt.toISOString();
  if (!laeuftSeit) return { soll: false, laeuft_seit: null };
  const r = await db.query<{ offen: boolean; stop: boolean }>(
    `SELECT bool_or(status IN ('pending','claimed','accepted')) AS offen,
            bool_or(art = 'stop' AND status IN ('pending','claimed','accepted','completed') AND erstellt_am > $2) AS stop
       FROM agent_runtime_auftraege WHERE identity_id = $1`, [identityId, laeuftSeit]);
  if (r.rows[0]?.stop) return { soll: false, laeuft_seit: null };
  return { soll: !r.rows[0]?.offen, laeuft_seit: laeuftSeit };
}

/**
 * Ein Ueberwachungstakt. trocken: nur bewerten (auch bei Schalter AUS), nichts ausfuehren, Stand nicht schreiben.
 * Wirft nie; Fehler stehen im Bericht.
 */
export async function fuehreUeberwachungsTaktAus(d: UeberwachungsDienste, opt: { trocken?: boolean } = {}): Promise<TaktBericht> {
  const trocken = opt.trocken === true;
  const bericht: TaktBericht = { aktiv: false, trocken, zeit: new Date().toISOString(), runtimes: [], kette: [], letzter_fehler: null };
  if (taktLaeuft && !trocken) return { ...bericht, uebersprungen: 'laeuft_schon' };
  let sperre: PoolClient | null = null;
  if (!trocken) taktLaeuft = true;
  try {
    const schalter = await leseRuntimeUeberwachungSchalter();
    bericht.aktiv = schalter.aktiv;
    if (!schalter.aktiv && !trocken) return { ...bericht, uebersprungen: 'schalter_aus' };
    const pool = getPool();
    if (!trocken) {
      sperre = await pool.connect();
      const l = await sperre.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [SPERRE]);
      if (!l.rows[0]?.ok) { sperre.release(); sperre = null; return { ...bericht, uebersprungen: 'andere_instanz' }; }
    }
    const e = await leseRuntimeUeberwachungWerte();
    const staende = await leseUeberwachungStaende();
    const haupt = await leseHauptagentSchalter().catch(() => ({ aktiv: false }));
    const mainId = haupt.aktiv ? await hauptagentIdentitaetsId().catch(() => null) : null;
    const mainRt = await d.mainRuntime().catch(() => null);
    const jetzt = new Date();
    for (const rt of UEBERWACHTE_RUNTIMES) {
      const zeile: TaktBericht['runtimes'][number] = { runtime: rt, beobachtung: null, entscheidung: null, ausgefuehrt: null, fehler: null };
      bericht.runtimes.push(zeile);
      const s = staende[rt];
      try {
        const c = await d.beobachte(rt, { probe_timeout_ms: e.probe_timeout_sekunden * 1000, daemon_frisch_ms: e.daemon_frisch_sekunden * 1000 });
        const istMain = mainRt === rt;
        const apiVerbunden = c.container === 'laeuft' ? await runtimeDaemonAngemeldet(rt, e.daemon_frisch_sekunden * 1000) : false;
        let wrapper: RuntimeBeobachtung['main_wrapper'] = null;
        let soll = { soll: false, laeuft_seit: istMain ? s.main_laeuft_seit : null as string | null };
        let ackHaengt = false;
        if (istMain && mainId) {
          wrapper = (await leseMainLauf(mainId, rt)).zustand;
          soll = await mainSollLaufen(pool, mainId, s, wrapper, jetzt);
          const a = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM agent_runtime_auftraege WHERE identity_id=$1 AND status='claimed' AND aktualisiert_am < NOW() - make_interval(secs => $2)`,
            [mainId, e.ack_frist_sekunden]);
          ackHaengt = (a.rows[0]?.n ?? 0) > 0;
        }
        const kontingent = e.kontingent_ausloeser && !!s.kontingent_bis && Date.parse(s.kontingent_bis) > jetzt.getTime();
        const b: RuntimeBeobachtung = { ...c, api_verbunden: apiVerbunden, ack_haengt: ackHaengt, ist_main: istMain, main_wrapper: wrapper, main_soll_laufen: soll.soll,
          kontingent_erschoepft: kontingent };
        zeile.beobachtung = b;
        const ent = bewerteRuntime(b, s, e, jetzt.getTime());
        zeile.entscheidung = ent;
        if (trocken) { staende[rt] = { ...s, zustand: ent.zustand, ursache: ent.ursache }; continue; }
        // Stand fortschreiben
        const neu: UeberwachungStand = { ...s, beobachtung: { ...c, api_verbunden: apiVerbunden, ack_haengt: ackHaengt, main_wrapper: wrapper }, letzter_fehler: c.fehler };
        if (c.container === 'laeuft') neu.container_soll_laufen = true;
        neu.main_laeuft_seit = istMain ? soll.laeuft_seit : s.main_laeuft_seit;
        if (ent.zustand === 'ok') { neu.letzter_ok = jetzt.toISOString(); neu.versuche = []; }
        if (ent.zustand !== s.zustand || ent.ursache !== s.ursache) {
          neu.seit = jetzt.toISOString();
          const art = ent.zustand === 'ok' ? (s.zustand === 'unbekannt' ? 'erkannt_ok' : 'wiederhergestellt') : 'zustand_' + ent.zustand;
          await schreibeEreignis(pool, rt, art, ent.ursache, { vorher: s.zustand, hinweis: ent.hinweis, container: c.container, prozess: c.prozess, api_verbunden: apiVerbunden });
        }
        neu.zustand = ent.zustand;
        neu.ursache = ent.ursache;
        if (ent.zustand === 'abgeloest' && e.wiederbelebung_minuten > 0
          && (!s.wiederbelebung_letzter || jetzt.getTime() - Date.parse(s.wiederbelebung_letzter) >= e.wiederbelebung_minuten * 60_000)) {
          // Nachtrag 2 K2: der gefencte Container wird regelmaessig wieder angestossen, damit 'automatisch zurueck' moeglich ist.
          neu.wiederbelebung_letzter = jetzt.toISOString();
          try {
            await d.starteContainer(rt);
            zeile.ausgefuehrt = 'wiederbelebung';
            await schreibeEreignis(pool, rt, 'wiederbelebung', ent.ursache, null);
          } catch (err) {
            const meldung = ((err as Error).message ?? String(err)).slice(0, 500);
            zeile.fehler = meldung;
            await schreibeEreignis(pool, rt, 'wiederbelebung_fehlgeschlagen', ent.ursache, { meldung });
          }
        }
        if (ent.massnahme === 'failover_faellig') {
          // Die Kette (fuehreKetteAus) laeuft nach der Bewertung aller Runtimes und vermerkt ihre Schritte selbst.
        } else if (ent.massnahme !== 'keine') {
          neu.versuche = [...s.versuche, { zeit: jetzt.toISOString(), art: ent.massnahme, ursache: ent.ursache }].slice(-20);
          try {
            if (ent.massnahme === 'container_start') await d.starteContainer(rt);
            else if (ent.massnahme === 'container_restart') await d.neustartContainer(rt);
            else if (ent.massnahme === 'wrapper_respawn' && mainId) {
              await stelleMainLaufSicher({ identity_id: mainId, runtime: rt, modell: await d.standardModell(rt), warte_ms: 0 });
            }
            zeile.ausgefuehrt = ent.massnahme;
            await schreibeEreignis(pool, rt, ent.massnahme, ent.ursache, { versuch: neu.versuche.length });
          } catch (err) {
            const meldung = ((err as Error).message ?? String(err)).slice(0, 500);
            zeile.fehler = meldung;
            neu.letzter_fehler = meldung;
            await schreibeEreignis(pool, rt, ent.massnahme + '_fehlgeschlagen', ent.ursache, { meldung });
          }
        }
        await schreibeStand(pool, neu);
        staende[rt] = neu;
      } catch (err) {
        zeile.fehler = ((err as Error).message ?? String(err)).slice(0, 500);
      }
    }
    // Nachtrag 2: Kette (Fencing + Umzug aller Agenten) und automatische Rueckkehr, mit den frischen Staenden dieses Takts.
    try {
      if (e.failover_erlaubt) await fuehreKetteAus(d, e, staende, mainId, trocken, bericht);
      if (e.zurueck_automatisch) await fuehreRueckkehrAus(d, e, staende, trocken, bericht);
    } catch (err) {
      bericht.letzter_fehler = ((err as Error).message ?? String(err)).slice(0, 500);
    }
    if (!trocken) {
      await pool.query('DELETE FROM runtime_ueberwachung_ereignisse WHERE zeit < NOW() - make_interval(days => $1)', [e.ereignisse_tage]).catch(() => undefined);
    }
  } catch (err) {
    bericht.letzter_fehler = ((err as Error).message ?? String(err)).slice(0, 500);
  } finally {
    if (sperre) {
      await sperre.query('SELECT pg_advisory_unlock(hashtext($1))', [SPERRE]).catch(() => undefined);
      sperre.release();
    }
    if (!trocken) taktLaeuft = false;
  }
  if (!trocken) letzterTakt = bericht;
  return bericht;
}

// ---------------------------------------------------------------------------------------------
// Kette (Nachtrag 2, K1-K8): Claude -> Codex -> Free fuer alle Agenten des ausgefallenen Containers, automatisch zurueck
// ---------------------------------------------------------------------------------------------
export type KettenRuntime = UeberwachteRuntime | 'free-pool';
export interface KettenSchritt {
  art: 'abgeloest' | 'umzug' | 'wechsel_stop' | 'kein_ziel' | 'zurueck_stop' | 'zurueck' | 'weiter' | 'warten_busy' | 'fehler';
  identity_id?: string;
  project?: string;
  von?: KettenRuntime;
  nach?: KettenRuntime | null;
  uebersprungen?: Array<{ runtime: KettenRuntime; grund: string }>;
  meldung?: string;
}

/**
 * Free-Stufe (K8): W6/T41 registriert hier seinen Free-Worker (Wrapper/Identitaetsweg). Ohne Registrierung wird die Stufe mit
 * 'free_worker_fehlt' uebersprungen; die Kette selbst bleibt unveraendert.
 */
export interface FreeAusfuehrer {
  verfuegbar(): Promise<{ ja: boolean; grund?: string }>;
  uebernehme(e: { identity_id: string; project: string; agent_name: string | null; ist_main: boolean; spawn_args: Record<string, unknown> | null }): Promise<{ job_id?: string | null }>;
  beende(e: { identity_id: string; project: string }): Promise<void>;
}
let freeAusfuehrer: FreeAusfuehrer | null = null;
export function registriereFreeAusfuehrer(a: FreeAusfuehrer | null): void { freeAusfuehrer = a; }

interface ContainerAgent {
  identity_id: string; project: string; agent_name: string | null; model: string | null; wrapper_pid: number | null;
  runtime: UeberwachteRuntime; ist_main: boolean;
}

/** K3: Identitaeten mit lebendem Wrapper im Container dieser Runtime (Pfad unter /projects, Runtime aus dem letzten spawn-Job). */
async function agentenDerRuntime(db: Db, rt: UeberwachteRuntime, mainId: string | null): Promise<ContainerAgent[]> {
  const r = await db.query<{ identity_id: string; project: string; agent_name: string | null; model: string | null; wrapper_pid: number | null; ziel: string | null }>(
    `SELECT w.identity_id, w.project, w.agent_name, w.model, w.wrapper_pid,
            (SELECT j.args->>'target_runtime' FROM specialist_jobs j WHERE j.target_identity_id = w.identity_id AND j.project = w.project
               AND j.action = 'spawn' ORDER BY j.created_at DESC LIMIT 1) AS ziel
       FROM agent_identitaet_wrapper_status w
      WHERE w.status IN ('running','idle') AND w.socket_path LIKE $1
        -- schon unterwegs auf eine andere Runtime (offener Umzug mit anderem Ziel): nicht noch einmal umziehen
        AND NOT EXISTS (SELECT 1 FROM runtime_ueberwachung_umzuege u WHERE u.identity_id = w.identity_id
                          AND u.status IN ('aktiv','wechsel_stop','zurueck_stop') AND u.nach_runtime <> $2)`, [RUNTIME_PROJEKTE_WURZEL + '/%', rt]);
  return r.rows.map(z => ({
    identity_id: z.identity_id, project: z.project, agent_name: z.agent_name, model: z.model, wrapper_pid: z.wrapper_pid,
    runtime: (UEBERWACHTE_RUNTIMES as readonly string[]).includes(z.ziel ?? '') ? z.ziel as UeberwachteRuntime : (/^codex/.test(z.model ?? '') ? 'codex' : 'claude'),
    ist_main: z.identity_id === mainId,
  })).filter(a => a.runtime === rt);
}

/** K4: erste verfuegbare Stufe der Reihenfolge ausser der aktuellen. Kein bezahlter Fallback (api-* nie in der Kette). */
async function waehleZiel(aktuell: KettenRuntime, e: RuntimeUeberwachungWerte, staende: Record<UeberwachteRuntime, UeberwachungStand>, nurAbo = false):
  Promise<{ ziel: KettenRuntime | null; uebersprungen: Array<{ runtime: KettenRuntime; grund: string }> }> {
  const uebersprungen: Array<{ runtime: KettenRuntime; grund: string }> = [];
  for (const r of e.failover_reihenfolge as KettenRuntime[]) {
    if (r === aktuell) continue;
    if (r === 'free-pool') {
      if (nurAbo) continue;
      if (!freeAusfuehrer) { uebersprungen.push({ runtime: r, grund: 'free_worker_fehlt' }); continue; }
      const v = await freeAusfuehrer.verfuegbar().catch(() => ({ ja: false, grund: 'free_pruefung_fehlgeschlagen' }));
      if (v.ja) return { ziel: r, uebersprungen };
      uebersprungen.push({ runtime: r, grund: v.grund ?? 'free_nicht_verfuegbar' });
      continue;
    }
    if (staende[r].zustand === 'ok') return { ziel: r, uebersprungen };
    uebersprungen.push({ runtime: r, grund: 'zustand_' + staende[r].zustand });
  }
  return { ziel: null, uebersprungen };
}

async function letzteSpawnArgs(db: Db, identityId: string, project: string): Promise<Record<string, unknown> | null> {
  const r = await db.query<{ args: Record<string, unknown> | null }>(
    `SELECT args FROM specialist_jobs WHERE target_identity_id = $1 AND project = $2 AND action = 'spawn' ORDER BY created_at DESC LIMIT 1`, [identityId, project]);
  return r.rows[0]?.args ?? null;
}

async function modellFuer(ziel: UeberwachteRuntime, gewuenscht: string | null, d: UeberwachungsDienste): Promise<string> {
  // P22-T62: Schalter hauptagent_cli_modelle EIN -> Ursprungsmodell nur, wenn es in der Liste der Ziel-Runtime steht
  // (AUS: Altregel modellPasstZuRuntime). Sonst Standard der Ziel-Runtime (User-Wahl bzw. kleinstes Modell).
  if (!gewuenscht) return d.standardModell(ziel);
  const p = await pruefeModellFuerRuntime(gewuenscht, ziel);
  if (p.quelle === 'schalter_aus') return modellPasstZuRuntime(gewuenscht, ziel) ? gewuenscht : d.standardModell(ziel);
  return p.passt ? p.modell : d.standardModell(ziel);
}

/** Main: Auftrag runtime_wechsel als System (Ausfuehrung T6c). Offener Auftrag gleicher Art -> null. Ausweis/Profil bleiben. */
async function legeSystemWechselAn(db: Db, identityId: string, gewuenscht: Record<string, string>, grund: string): Promise<string | null> {
  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO agent_runtime_auftraege (id, identity_id, art, status, gewuenscht, grund, erstellt_von)
       VALUES ($1,$2,'runtime_wechsel','pending',$3::jsonb,$4,'runtime-ueberwachung')`, [id, identityId, JSON.stringify(gewuenscht), grund]);
    await db.query(
      `INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id) VALUES ($1,'runtime-ueberwachung','runtime_auftrag_angelegt',NULL,$2::jsonb,$3,NULL)`,
      [identityId, JSON.stringify({ auftrag_id: id, art: 'runtime_wechsel', gewuenscht }), grund]);
    return id;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

/** Spawn eines Nicht-Main-Agenten auf einer Container-Runtime mit den Args seines letzten Starts (gleiche Identitaet). */
async function spawneAuf(ziel: UeberwachteRuntime, a: { identity_id: string; project: string }, args: Record<string, unknown> | null, modell: string): Promise<string> {
  if (!args) throw new Error('spawn_args_fehlen');
  const job = await enqueueSpecialistJob({ project: a.project, action: 'spawn',
    args: { ...args, identity_id: a.identity_id, model: modell, target_runtime: ziel, project_path: runtimeProjektPfad(a.project) } });
  return job.id;
}

/** K1/K2/K5: ausgefallene Runtime fencen und ihre Agenten umziehen. */
async function fuehreKetteAus(d: UeberwachungsDienste, e: RuntimeUeberwachungWerte, staende: Record<UeberwachteRuntime, UeberwachungStand>,
  mainId: string | null, trocken: boolean, bericht: TaktBericht): Promise<void> {
  const pool = getPool();
  for (const rt of UEBERWACHTE_RUNTIMES) {
    const zustand = staende[rt].zustand;
    if (zustand !== 'ausgefallen' && zustand !== 'erschoepft' && zustand !== 'abgeloest') continue;
    // ausgefallen = Container kaputt -> Fencing; erschoepft = Container gesund, Abo-Kontingent leer -> Wechsel ohne Fencing;
    // abgeloest = schon gefenct: Agenten, die damals kein Ziel hatten, ziehen nach, sobald eines frei ist (ohne neues Ereignis).
    const fencing = zustand === 'ausgefallen';
    const nachzug = zustand === 'abgeloest';
    const agenten = await agentenDerRuntime(pool, rt, mainId);
    if (!fencing && agenten.length === 0) continue;
    if (fencing) bericht.kette.push({ art: 'abgeloest', von: rt, meldung: agenten.length + ' Agent(en) betroffen' });
    if (fencing && !trocken) {
      // K2 Fencing: kein zweiter Agent durch reconnectAll eines spaeter wieder laufenden Daemons.
      let fehlerText: string | null = null;
      try { await d.stoppeContainer(rt); } catch (err) { fehlerText = ((err as Error).message ?? String(err)).slice(0, 500); }
      const neu: UeberwachungStand = { ...staende[rt], zustand: 'abgeloest', seit: new Date().toISOString(), container_soll_laufen: false,
        wiederbelebung_letzter: new Date().toISOString(), letzter_fehler: fehlerText ?? staende[rt].letzter_fehler };
      await schreibeStand(pool, neu);
      staende[rt] = neu;
      await schreibeEreignis(pool, rt, fehlerText ? 'fencing_fehlgeschlagen' : 'abgeloest', staende[rt].ursache, { agenten: agenten.length, ...(fehlerText ? { meldung: fehlerText } : {}) });
    }
    for (const a of agenten) {
      const { ziel, uebersprungen } = await waehleZiel(rt, e, staende);
      if (!ziel && nachzug) continue;
      if (!ziel) {
        bericht.kette.push({ art: 'kein_ziel', identity_id: a.identity_id, project: a.project, von: rt, nach: null, uebersprungen });
        if (!trocken) await schreibeEreignis(pool, rt, 'failover_kein_ziel', null, { identity_id: a.identity_id, project: a.project, uebersprungen });
        continue;
      }
      bericht.kette.push({ art: zustand === 'erschoepft' ? 'wechsel_stop' : 'umzug', identity_id: a.identity_id, project: a.project, von: rt, nach: ziel, uebersprungen });
      if (trocken) continue;
      await zieheUm(d, a, rt, ziel, staende[rt].ursache, bericht, zustand === 'erschoepft' ? 'wechsel' : 'fencing');
    }
  }
}

/**
 * modus fencing: alter Container ist angehalten -> sofort auf dem Ziel starten (Main per runtime_wechsel failover).
 * modus wechsel: alter Container laeuft (Kontingent erschoepft) -> erst stop-Job auf der alten Runtime, spawn im naechsten Takt
 * (Status wechsel_stop); der Main wechselt per normalem runtime_wechsel (T6c stoppt selbst auf der alten Runtime).
 */
async function zieheUm(d: UeberwachungsDienste, a: ContainerAgent, von: KettenRuntime, ziel: KettenRuntime, ursache: string | null, bericht: TaktBericht,
  modus: 'fencing' | 'wechsel' = 'fencing'): Promise<void> {
  const pool = getPool();
  const offen = (await pool.query<{ id: string; ursprung_runtime: string; modell_ursprung: string | null; spawn_args: Record<string, unknown> | null }>(
    `SELECT id::text AS id, ursprung_runtime, modell_ursprung, spawn_args FROM runtime_ueberwachung_umzuege WHERE identity_id = $1 AND status IN ('aktiv','wechsel_stop','zurueck_stop')`,
    [a.identity_id])).rows[0];
  const spawnArgs = offen?.spawn_args ?? (a.ist_main ? null : await letzteSpawnArgs(pool, a.identity_id, a.project));
  const modellUrsprung = offen ? offen.modell_ursprung : a.model;
  let jobId: string | null = null;
  let auftragId: string | null = null;
  let fehlerText: string | null = null;
  let stopJobId: string | null = null;
  try {
    if (modus === 'wechsel' && !(a.ist_main && ziel !== 'free-pool')) {
      const stop = await enqueueSpecialistJob({ project: a.project, action: 'stop',
        args: { name: a.agent_name, identity_id: a.identity_id, project_path: runtimeProjektPfad(a.project), target_runtime: von } });
      stopJobId = stop.id;
    } else if (modus === 'wechsel') {
      const modell = await modellFuer(ziel as UeberwachteRuntime, modellUrsprung, d);
      auftragId = await legeSystemWechselAn(pool, a.identity_id, { runtime: ziel, modell }, 'kontingent:' + (ursache ?? von));
      if (!auftragId) throw new Error('runtime_wechsel_offen');
    } else if (ziel === 'free-pool') {
      jobId = (await freeAusfuehrer!.uebernehme({ identity_id: a.identity_id, project: a.project, agent_name: a.agent_name, ist_main: a.ist_main, spawn_args: spawnArgs })).job_id ?? null;
    } else if (a.ist_main) {
      const modell = await modellFuer(ziel, modellUrsprung, d);
      auftragId = await legeSystemWechselAn(pool, a.identity_id, { runtime: ziel, modell, failover: 'ja' }, 'failover:' + (ursache ?? von));
      if (!auftragId) throw new Error('runtime_wechsel_offen');
    } else {
      // Wrapper-Zeile per CAS auf crashed (der Prozess ist mit dem Container angehalten), dann neuer Start auf dem Ziel.
      await pool.query(`UPDATE agent_identitaet_wrapper_status SET status='crashed', busy=false WHERE identity_id=$1 AND project=$2 AND wrapper_pid IS NOT DISTINCT FROM $3`,
        [a.identity_id, a.project, a.wrapper_pid]);
      jobId = await spawneAuf(ziel, a, spawnArgs, await modellFuer(ziel, modellUrsprung, d));
    }
  } catch (err) {
    fehlerText = ((err as Error).message ?? String(err)).slice(0, 500);
  }
  // wechsel_stop: nach_runtime bleibt die alte Runtime, bis der stop-Job durch ist; das Ziel steht in rueck_ziel.
  const status = fehlerText ? 'fehlgeschlagen' : stopJobId ? 'wechsel_stop' : 'aktiv';
  const nach = stopJobId ? von : ziel;
  const rueckZiel = stopJobId ? ziel : null;
  if (offen) {
    await pool.query(
      `UPDATE runtime_ueberwachung_umzuege SET von_runtime=$2, nach_runtime=$3, status=$4, job_id=$5, auftrag_id=$6, letzter_fehler=$7, ursache=$8, stop_job_id=$9,
         rueck_ziel=$10, aktualisiert_am=NOW(), abgeschlossen_am=CASE WHEN $4='fehlgeschlagen' THEN NOW() ELSE NULL END WHERE id=$1::bigint`,
      [offen.id, von, nach, status, jobId, auftragId, fehlerText, ursache, stopJobId, rueckZiel]);
  } else {
    await pool.query(
      `INSERT INTO runtime_ueberwachung_umzuege (identity_id, project, agent_name, ist_main, ursprung_runtime, von_runtime, nach_runtime, modell_ursprung, spawn_args,
         status, ursache, job_id, auftrag_id, letzter_fehler, stop_job_id, rueck_ziel, abgeschlossen_am)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $9='fehlgeschlagen' THEN NOW() ELSE NULL END)`,
      [a.identity_id, a.project, a.agent_name, a.ist_main, von, nach, modellUrsprung, spawnArgs ? JSON.stringify(spawnArgs) : null, status, ursache, jobId, auftragId, fehlerText,
        stopJobId, rueckZiel]);
  }
  await schreibeEreignis(pool, String(von), fehlerText ? 'umzug_fehlgeschlagen' : stopJobId ? 'wechsel_stop' : 'umzug', ursache,
    { identity_id: a.identity_id, project: a.project, nach: ziel, ...(jobId ? { job_id: jobId } : {}), ...(auftragId ? { auftrag_id: auftragId } : {}),
      ...(stopJobId ? { stop_job_id: stopJobId } : {}), ...(fehlerText ? { meldung: fehlerText } : {}) });
  if (fehlerText) bericht.kette.push({ art: 'fehler', identity_id: a.identity_id, project: a.project, von, nach: ziel, meldung: fehlerText });
}

interface UmzugZeile {
  id: string; identity_id: string; project: string; agent_name: string | null; ist_main: boolean; ursprung_runtime: KettenRuntime;
  von_runtime: KettenRuntime; nach_runtime: KettenRuntime; rueck_ziel: KettenRuntime | null; modell_ursprung: string | null;
  spawn_args: Record<string, unknown> | null; status: string; stop_job_id: string | null;
}

/** K7: zurueck zum Ursprung (bzw. von Free auf ein verfuegbares Abo), nie mitten in Arbeit; Nicht-Main zweistufig (stop, dann spawn). */
async function fuehreRueckkehrAus(d: UeberwachungsDienste, e: RuntimeUeberwachungWerte, staende: Record<UeberwachteRuntime, UeberwachungStand>,
  trocken: boolean, bericht: TaktBericht): Promise<void> {
  const pool = getPool();
  const r = await pool.query<UmzugZeile>(
    `SELECT id::text AS id, identity_id, project, agent_name, ist_main, ursprung_runtime, von_runtime, nach_runtime, rueck_ziel, modell_ursprung,
            spawn_args, status, stop_job_id FROM runtime_ueberwachung_umzuege WHERE status IN ('aktiv','wechsel_stop','zurueck_stop') ORDER BY erstellt_am`);
  for (const u of r.rows) {
    try {
      // Zweite Stufe von Rueckkehr (zurueck_stop) und Kontingent-Wechsel (wechsel_stop): stop-Job durch -> auf dem Ziel starten.
      if (u.status === 'zurueck_stop' || u.status === 'wechsel_stop') {
        const j = (await pool.query<{ status: string }>('SELECT status FROM specialist_jobs WHERE id = $1', [u.stop_job_id])).rows[0];
        if (j && (j.status === 'pending' || j.status === 'running')) continue;
        if (trocken || !u.rueck_ziel) continue;
        let jobId: string | null;
        if (u.rueck_ziel === 'free-pool') {
          if (!freeAusfuehrer) throw new Error('free_worker_fehlt');
          jobId = (await freeAusfuehrer.uebernehme({ identity_id: u.identity_id, project: u.project, agent_name: u.agent_name, ist_main: u.ist_main, spawn_args: u.spawn_args })).job_id ?? null;
        } else {
          jobId = await spawneAuf(u.rueck_ziel, u, u.spawn_args, await modellFuer(u.rueck_ziel, u.modell_ursprung, d));
        }
        const fertig = u.rueck_ziel === u.ursprung_runtime;
        await pool.query(
          `UPDATE runtime_ueberwachung_umzuege SET status=$2, von_runtime=nach_runtime, nach_runtime=$3, job_id=$4, rueck_ziel=NULL, aktualisiert_am=NOW(),
             abgeschlossen_am=CASE WHEN $2='zurueck' THEN NOW() ELSE NULL END WHERE id=$1::bigint`, [u.id, fertig ? 'zurueck' : 'aktiv', u.rueck_ziel, jobId]);
        bericht.kette.push({ art: fertig ? 'zurueck' : 'weiter', identity_id: u.identity_id, project: u.project, von: u.nach_runtime, nach: u.rueck_ziel });
        await schreibeEreignis(pool, u.rueck_ziel, fertig ? 'zurueck' : 'weiter', null, { identity_id: u.identity_id, project: u.project, von: u.nach_runtime, job_id: jobId });
        continue;
      }
      const ursprung = u.ursprung_runtime as UeberwachteRuntime;
      let ziel: KettenRuntime | null = null;
      if ((UEBERWACHTE_RUNTIMES as readonly string[]).includes(ursprung) && staende[ursprung].zustand === 'ok') ziel = ursprung;
      else if (u.nach_runtime === 'free-pool') ziel = (await waehleZiel('free-pool', e, staende, true)).ziel;
      if (!ziel || ziel === u.nach_runtime) continue;
      if (u.nach_runtime !== 'free-pool') {
        const w = (await pool.query<{ busy: boolean; status: string }>(
          'SELECT busy, status FROM agent_identitaet_wrapper_status WHERE identity_id=$1 AND project=$2', [u.identity_id, u.project])).rows[0];
        if (w?.busy) { bericht.kette.push({ art: 'warten_busy', identity_id: u.identity_id, project: u.project, von: u.nach_runtime, nach: ziel }); continue; }
      }
      bericht.kette.push({ art: u.ist_main || u.nach_runtime === 'free-pool' ? 'zurueck' : 'zurueck_stop', identity_id: u.identity_id, project: u.project, von: u.nach_runtime, nach: ziel });
      if (trocken) continue;
      const zielRt = ziel as UeberwachteRuntime;
      if (u.ist_main && u.nach_runtime !== 'free-pool') {
        const modell = await modellFuer(zielRt, u.modell_ursprung, d);
        const auftragId = await legeSystemWechselAn(pool, u.identity_id, { runtime: zielRt, modell }, 'zurueck:' + zielRt + ' wieder verfuegbar');
        if (!auftragId) continue;
        const fertig = zielRt === u.ursprung_runtime;
        await pool.query(
          `UPDATE runtime_ueberwachung_umzuege SET status=$2, von_runtime=nach_runtime, nach_runtime=$3, auftrag_id=$4, aktualisiert_am=NOW(),
             abgeschlossen_am=CASE WHEN $2='zurueck' THEN NOW() ELSE NULL END WHERE id=$1::bigint`, [u.id, fertig ? 'zurueck' : 'aktiv', zielRt, auftragId]);
        await schreibeEreignis(pool, zielRt, fertig ? 'zurueck' : 'weiter', null, { identity_id: u.identity_id, project: u.project, von: u.nach_runtime, auftrag_id: auftragId });
      } else if (u.nach_runtime === 'free-pool') {
        if (freeAusfuehrer) await freeAusfuehrer.beende({ identity_id: u.identity_id, project: u.project });
        const jobId = u.ist_main
          ? await legeSystemWechselAn(pool, u.identity_id, { runtime: zielRt, modell: await modellFuer(zielRt, u.modell_ursprung, d) }, 'zurueck:' + zielRt + ' wieder verfuegbar')
          : await spawneAuf(zielRt, u, u.spawn_args, await modellFuer(zielRt, u.modell_ursprung, d));
        const fertig = zielRt === u.ursprung_runtime;
        await pool.query(
          `UPDATE runtime_ueberwachung_umzuege SET status=$2, von_runtime=nach_runtime, nach_runtime=$3, job_id=$4, aktualisiert_am=NOW(),
             abgeschlossen_am=CASE WHEN $2='zurueck' THEN NOW() ELSE NULL END WHERE id=$1::bigint`, [u.id, fertig ? 'zurueck' : 'aktiv', zielRt, jobId]);
        await schreibeEreignis(pool, zielRt, fertig ? 'zurueck' : 'weiter', null, { identity_id: u.identity_id, project: u.project, von: 'free-pool' });
      } else {
        const stop = await enqueueSpecialistJob({ project: u.project, action: 'stop',
          args: { name: u.agent_name, identity_id: u.identity_id, project_path: runtimeProjektPfad(u.project), target_runtime: u.nach_runtime } });
        await pool.query(`UPDATE runtime_ueberwachung_umzuege SET status='zurueck_stop', stop_job_id=$2, rueck_ziel=$3, aktualisiert_am=NOW() WHERE id=$1::bigint`,
          [u.id, stop.id, zielRt]);
        await schreibeEreignis(pool, u.nach_runtime, 'zurueck_stop', null, { identity_id: u.identity_id, project: u.project, ziel: zielRt, stop_job_id: stop.id });
      }
    } catch (err) {
      const meldung = ((err as Error).message ?? String(err)).slice(0, 500);
      bericht.kette.push({ art: 'fehler', identity_id: u.identity_id, project: u.project, meldung });
      if (!trocken) await pool.query('UPDATE runtime_ueberwachung_umzuege SET letzter_fehler=$2, aktualisiert_am=NOW() WHERE id=$1::bigint', [u.id, meldung]).catch(() => undefined);
    }
  }
}

/**
 * Meldung eines Wrappers zum Abo-Kontingent seiner Runtime (claude|codex). rejected -> erschoepft bis resets_at (Sekunden/ms seit
 * Epoch oder ISO; fehlt sie: kontingent_ohne_reset_minuten). allowed nach rejected -> wieder frei. Wirft nie.
 */
export async function meldeRuntimeKontingent(e: {
  runtime: string; status: string; resets_at?: unknown; art?: string | null; project: string; agent: string;
}): Promise<{ gemeldet: boolean; kontingent_bis: string | null }> {
  try {
    if (!(UEBERWACHTE_RUNTIMES as readonly string[]).includes(e.runtime)) return { gemeldet: false, kontingent_bis: null };
    const pool = getPool();
    const vorher = (await pool.query<{ bis: Date | null }>('SELECT kontingent_bis AS bis FROM runtime_ueberwachung_stand WHERE runtime=$1', [e.runtime])).rows[0]?.bis ?? null;
    const aktivVorher = !!vorher && vorher.getTime() > Date.now();
    if (e.status === 'rejected') {
      const w = await leseRuntimeUeberwachungWerte();
      const reset = resetZeitMs(e.resets_at);
      const bis = new Date(reset && reset > Date.now() ? reset : Date.now() + w.kontingent_ohne_reset_minuten * 60_000);
      await pool.query(
        `INSERT INTO runtime_ueberwachung_stand (runtime, kontingent_bis, kontingent_art, kontingent_von, kontingent_gemeldet_am) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (runtime) DO UPDATE SET kontingent_bis=EXCLUDED.kontingent_bis, kontingent_art=EXCLUDED.kontingent_art,
           kontingent_von=EXCLUDED.kontingent_von, kontingent_gemeldet_am=NOW()`,
        [e.runtime, bis, e.art ?? null, e.project + '/' + e.agent]);
      if (!aktivVorher) await schreibeEreignis(pool, e.runtime, 'kontingent_erschoepft', e.art ?? null,
        { project: e.project, agent: e.agent, bis: bis.toISOString(), reset_bekannt: !!reset });
      return { gemeldet: true, kontingent_bis: bis.toISOString() };
    }
    if (e.status === 'allowed' && vorher) {
      await pool.query('UPDATE runtime_ueberwachung_stand SET kontingent_bis=NULL, kontingent_gemeldet_am=NOW() WHERE runtime=$1', [e.runtime]);
      if (aktivVorher) await schreibeEreignis(pool, e.runtime, 'kontingent_frei', e.art ?? null, { project: e.project, agent: e.agent });
      return { gemeldet: true, kontingent_bis: null };
    }
    return { gemeldet: false, kontingent_bis: aktivVorher ? vorher!.toISOString() : null };
  } catch (err) {
    console.error('[runtime-ueberwachung] Kontingent-Meldung nicht gespeichert:', (err as Error).message);
    return { gemeldet: false, kontingent_bis: null };
  }
}

/** resetsAt der CLIs: Zahl (Sekunden oder ms seit Epoch) oder Text (ISO bzw. Zahl). */
export function resetZeitMs(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;
  if (n !== null && Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

export async function leseUmzuege(limit = 20, db: Db = getPool()): Promise<Array<Record<string, unknown>>> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const r = await db.query<Record<string, unknown>>(
    `SELECT id::text AS id, identity_id, project, agent_name, ist_main, ursprung_runtime, von_runtime, nach_runtime, rueck_ziel, status, ursache,
            letzter_fehler, erstellt_am, aktualisiert_am, abgeschlossen_am
       FROM runtime_ueberwachung_umzuege ORDER BY (status IN ('aktiv','wechsel_stop','zurueck_stop')) DESC, erstellt_am DESC LIMIT $1`, [n]);
  return r.rows;
}

// ---------------------------------------------------------------------------------------------
// CLI-Update aus der API (F5): Entscheidung hier, Ausfuehrung 'synapse-runtime cli update' im Container (T4-Weg, versioniert)
// ---------------------------------------------------------------------------------------------
const CLI_SPERRE = 'synapse-runtime-cli-update';
let cliUpdateLaeuft = false;

/**
 * Faellige CLI-Updates (cli_update_stunden) je gesundem Container; erzwingen = sofort. Laufende Agenten werden nicht neu gestartet.
 * P22-T60: unabhaengig vom Schalter runtime_ueberwachung. Bei EIN gilt der Takt-Zustand ('ok'); bei AUS gibt es keinen Takt-Stand,
 * dann eigene leichte Beobachtung je faelliger Runtime (Container laeuft, Agent-Runtime-Image, Daemon haengt nicht).
 */
export async function fuehreCliUpdatesAus(d: UeberwachungsDienste, opt: { erzwingen?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
  const aus: Array<Record<string, unknown>> = [];
  if (cliUpdateLaeuft) return [{ uebersprungen: 'laeuft_schon' }];
  cliUpdateLaeuft = true;
  let sperre: PoolClient | null = null;
  try {
    const ueberwacht = (await leseRuntimeUeberwachungSchalter()).aktiv;
    const e = await leseRuntimeUeberwachungWerte();
    if (!e.cli_update_automatisch && !opt.erzwingen) return [{ uebersprungen: 'cli_update_aus' }];
    const pool = getPool();
    sperre = await pool.connect();
    if (!(await sperre.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [CLI_SPERRE])).rows[0]?.ok) {
      sperre.release(); sperre = null;
      return [{ uebersprungen: 'andere_instanz' }];
    }
    const staende = await leseUeberwachungStaende();
    for (const rt of UEBERWACHTE_RUNTIMES) {
      const s = staende[rt];
      if (ueberwacht && s.zustand !== 'ok') { aus.push({ runtime: rt, uebersprungen: 'zustand_' + s.zustand }); continue; }
      if (!opt.erzwingen && s.cli_update_am && Date.now() - Date.parse(s.cli_update_am) < e.cli_update_stunden * 3_600_000) {
        aus.push({ runtime: rt, uebersprungen: 'nicht_faellig' }); continue;
      }
      if (!ueberwacht) {
        const grund = await cliUpdateHindernis(d, rt, e);
        if (grund) { aus.push({ runtime: rt, uebersprungen: grund }); continue; }
      }
      let ergebnis: Record<string, unknown>;
      try {
        const r = await d.cliUpdate(rt, { timeout_ms: e.cli_update_timeout_minuten * 60_000 });
        ergebnis = { ok: r.ok, exit_code: r.exit_code, ausgabe: r.ausgabe.slice(-1000) };
      } catch (err) {
        ergebnis = { ok: false, exit_code: null, ausgabe: ((err as Error).message ?? String(err)).slice(0, 500) };
      }
      // Upsert: ohne Ueberwachung gibt es evtl. noch keine Stand-Zeile; der Takt schreibt cli_update_* nie.
      await pool.query(
        `INSERT INTO runtime_ueberwachung_stand (runtime, cli_update_am, cli_update_ergebnis) VALUES ($1, NOW(), $2::jsonb)
         ON CONFLICT (runtime) DO UPDATE SET cli_update_am=NOW(), cli_update_ergebnis=EXCLUDED.cli_update_ergebnis`,
        [rt, JSON.stringify(ergebnis)]);
      await schreibeEreignis(pool, rt, ergebnis.ok ? 'cli_update' : 'cli_update_fehlgeschlagen', null, ergebnis);
      aus.push({ runtime: rt, ...ergebnis });
    }
  } catch (err) {
    aus.push({ fehler: ((err as Error).message ?? String(err)).slice(0, 500) });
  } finally {
    if (sperre) {
      await sperre.query('SELECT pg_advisory_unlock(hashtext($1))', [CLI_SPERRE]).catch(() => undefined);
      sperre.release();
    }
    cliUpdateLaeuft = false;
  }
  return aus;
}

/** P22-T60: Gesundheit fuer das CLI-Update ohne Ueberwachungstakt (null = Update moeglich, sonst Grund fuers Ueberspringen). */
async function cliUpdateHindernis(d: UeberwachungsDienste, rt: UeberwachteRuntime, e: RuntimeUeberwachungWerte): Promise<string | null> {
  let b: ContainerBeobachtung;
  try {
    b = await d.beobachte(rt, { probe_timeout_ms: e.probe_timeout_sekunden * 1000, daemon_frisch_ms: e.daemon_frisch_sekunden * 1000 });
  } catch {
    return 'beobachtung_fehler';
  }
  if (b.container !== 'laeuft') return 'container_' + b.container;
  if (!b.agent_runtime_image) return 'kein_agent_runtime_image';
  if (b.prozess === 'haengt') return 'daemon_haengt';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Anbindung der rest-api (Docker-Dienste leben nur dort) und Lesen
// ---------------------------------------------------------------------------------------------
let dienste: UeberwachungsDienste | null = null;
/** Die rest-api (AgentRuntimeManager) meldet ihre Docker-Dienste an; ohne Anmeldung kein Takt in diesem Prozess. */
export function registriereUeberwachungsDienste(d: UeberwachungsDienste | null): void { dienste = d; }

/** Kurzfassung fuer hauptagent_status (auch fuer den Main selbst). Wirft nie. */
export async function ueberwachungKurz(): Promise<Record<string, unknown>> {
  try {
    const [schalter, staende] = await Promise.all([leseRuntimeUeberwachungSchalter(), leseUeberwachungStaende()]);
    return { aktiv: schalter.aktiv, quelle: schalter.quelle,
      runtimes: Object.values(staende).map(s => ({ runtime: s.runtime, zustand: s.zustand, ursache: s.ursache, seit: s.seit })) };
  } catch {
    return { aktiv: false, quelle: 'standard', runtimes: [], letzter_fehler: 'ueberwachung_nicht_lesbar' };
  }
}

export async function leseRuntimeUeberwachung(o: { ereignisse?: number } = {}): Promise<Record<string, unknown>> {
  const [schalter, einstellungen, staende, ereignisse, umzuege] = await Promise.all([
    leseRuntimeUeberwachungSchalter(), leseRuntimeUeberwachungEinstellungen(), leseUeberwachungStaende(), leseUeberwachungEreignisse(o.ereignisse ?? 20),
    leseUmzuege(20),
  ]);
  return { schalter, runtimes: Object.values(staende), ereignisse, umzuege, einstellungen, free_stufe: freeAusfuehrer ? 'registriert' : 'free_worker_fehlt (W6/T41)',
    takt_in_diesem_prozess: dienste !== null, letzter_takt: letzterTakt };
}

// ---------------------------------------------------------------------------------------------
// admin(action:'runtime_ueberwachung')
// ---------------------------------------------------------------------------------------------
export const RUNTIME_UEBERWACHUNG_ADMIN_ACTIONS = ['runtime_ueberwachung'] as const;
export const RUNTIME_UEBERWACHUNG_MODI = ['status', 'setzen', 'entfernen', 'takt_trocken', 'takt_jetzt', 'cli_update_jetzt'] as const;
export const RUNTIME_UEBERWACHUNG_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  ueberwachung_modus: { type: 'string', enum: [...RUNTIME_UEBERWACHUNG_MODI], description: 'runtime_ueberwachung: status (Standard) | setzen | entfernen | takt_trocken (nur bewerten) | takt_jetzt | cli_update_jetzt' },
  ueberwachung_werte: { type: 'object', additionalProperties: true, description: 'runtime_ueberwachung setzen: Einstellwerte {name: wert}' },
  ueberwachung_namen: { type: 'array', items: { type: 'string', enum: [...RUNTIME_UEBERWACHUNG_EINSTELLUNG_NAMEN] }, description: 'runtime_ueberwachung entfernen: Einstellwerte auf den Code-Standard zuruecksetzen' },
};

export function istRuntimeUeberwachungAdminAction(action: string | undefined): boolean {
  return typeof action === 'string' && (RUNTIME_UEBERWACHUNG_ADMIN_ACTIONS as readonly string[]).includes(action);
}

function projektDes(akteur: AusweisAkteur, args: Record<string, unknown>): string | null {
  const p = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null;
  if (p) return p;
  return akteur.art === 'identitaet' ? akteur.principal.project : null;
}

/** Lesen und Setzen: User und Koordinator (F6, wie P22-T57). */
export async function fuehreRuntimeUeberwachungAdminAus(action: string, args: Record<string, unknown>, akteur: W1bAkteur | AusweisAkteur | null): Promise<Record<string, unknown>> {
  try {
    if (!akteur) fehler('recht_fehlt');
    const wer = akteur as AusweisAkteur;
    const project = projektDes(wer, args);
    const modus = typeof args.ueberwachung_modus === 'string' ? args.ueberwachung_modus : 'status';
    if (!(RUNTIME_UEBERWACHUNG_MODI as readonly string[]).includes(modus)) fehler('modus_unbekannt', { erlaubt: RUNTIME_UEBERWACHUNG_MODI });
    switch (modus) {
      case 'status':
        await pruefeProfilVerwalter(wer, project);
        return { success: true, action, modus, ...(await leseRuntimeUeberwachung()) };
      case 'setzen':
        return { success: true, action, modus, einstellungen: await setzeRuntimeUeberwachungEinstellungen(wer, project, { werte: args.ueberwachung_werte, grund: args.grund }) };
      case 'entfernen':
        return { success: true, action, modus, einstellungen: await setzeRuntimeUeberwachungEinstellungen(wer, project, { entfernen: args.ueberwachung_namen, grund: args.grund }) };
      default: {
        await pruefeProfilVerwalter(wer, project);
        if (modus !== 'takt_trocken') pflichtText(args.grund, 'grund_fehlt');
        if (!dienste) fehler('takt_nicht_in_diesem_prozess', { hinweis: 'Die Ueberwachung laeuft nur in der Synapse-API.' });
        if (modus === 'cli_update_jetzt') return { success: true, action, modus, ergebnis: await fuehreCliUpdatesAus(dienste, { erzwingen: true }) };
        return { success: true, action, modus, bericht: await fuehreUeberwachungsTaktAus(dienste, { trocken: modus === 'takt_trocken' }) };
      }
    }
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, action, error: err.code, ...(err.details ? { details: err.details } : {}) };
    return { success: false, action, error: 'runtime_ueberwachung_fehler' };
  }
}
