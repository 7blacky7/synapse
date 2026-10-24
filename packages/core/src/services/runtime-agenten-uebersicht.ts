/**
 * P22-T116 (User 24.10.2026): Runtime-Container debugbar machen - ALLE laufenden Agenten sehen, egal wie gestartet
 * (Main, Koordinator, Spezialist), damit kein Agent unbemerkt im Hintergrund das Abo verbraucht.
 * BEFUND: specialist(status, name) las bei Klartext-Namen nur wrapper_status (Legacy). Identitaets-Agenten (z. B. vom Main
 *   im Container gestartete Koordinatoren) stehen in agent_identitaet_wrapper_status -> 'nicht gefunden'.
 * STUFE 1 (dieser Dienst): (a) Namenssuche auch in den Identitaets-Zeilen, (b) Uebersicht je Ort/Runtime mit Warnungen.
 * SCHALTER: Produkt-Schalter runtime_agenten_uebersicht (je Projekt/global, Standard AUS, nur ausdruecklich). AUS = Altverhalten.
 * DEBUG: jede Antwort traegt debug {schalter, zeilen je quelle, suchweg}.
 * Nur lesend, wirft nie (Fehler -> leere Uebersicht mit debug.fehler).
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { listWrapperStatus, type WrapperStatusRow } from './wrapper-status.js';
import { leseRuntimeAgentenGrenzen, runtimeAgentenGrenzenJetzt } from './runtime-agenten-grenzen.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';

/**
 * P22-T125 (User 24.10.2026): Schalter wrapper_status_ursache (Produkt-Schalter, Std AUS). EIN:
 *  (1) anzeige_status aus belegter Ende-Ursache: container_restart|container_start -> 'beendet_durch_neustart', sonst 'crashed'
 *      (prozess_weg / ohne Beleg). Der DB-Status bleibt 'crashed' (Reconcile, Respawn, UI-Altleser unveraendert).
 *  (2) beendet_* gelten nur fuer die Laufgeneration, in der sie erkannt wurden: status 'crashed' UND beendet_details.wrapper_pid
 *      = aktuelle wrapper_pid. Ein neuer Lauf (running/idle oder neue PID) zeigt keine Ende-Ursache des Vorlaufs mehr.
 *  (3) du_selbst: Zeile mit der identity_id des Aufrufers (Ausweis) wird gekennzeichnet.
 * DEBUG: debug.wrapper_status_ursache, debug.selbst_identity_id, je Zeile beendet.veraltet_verworfen.
 */
export const WRAPPER_STATUS_URSACHE_FUNKTION = 'wrapper_status_ursache' as const;
export type WrapperAnzeigeStatus = 'running' | 'idle' | 'stopped' | 'crashed' | 'beendet_durch_neustart';
export interface WrapperEndeAnzeige {
  anzeige_status: WrapperAnzeigeStatus;
  beendet: { ursache: string; erkannt_am: string | null; ereignis_id: string | null } | null;
  /** true = es stand ein beendet_*-Befund, der nicht zu dieser Laufgeneration gehoert (verworfen). */
  veraltet_verworfen: boolean;
}
const NEUSTART_URSACHEN = ['container_restart', 'container_start'];

/**
 * Rein, testbar (P22-T125 R2c): Laufbindung ausschliesslich an (PID, unverkuerzter PG-Text).
 * Der crashed-UPDATE behaelt last_activity, jeder neue Upsert aendert es. JS-Date verliert Mikrosekunden und darf hier
 * weder vergleichen noch einen fehlenden PG-Text ersetzen. Alte ISO-/Millisekundenbelege passen nicht zum PG-Text.
 */
export function wrapperEndeAnzeige(row: Pick<WrapperStatusRow, 'status' | 'wrapperPid' | 'lastActivity' | 'lastActivityExakt' | 'beendetUrsache' | 'beendetErkanntAm' | 'beendetDetails'>): WrapperEndeAnzeige {
  const hat = !!row.beendetUrsache;
  const d = row.beendetDetails;
  const pid = d && typeof d.wrapper_pid === 'number' ? d.wrapper_pid : null;
  const ll = d && typeof d.letztes_lebenszeichen === 'string' ? d.letztes_lebenszeichen : null;
  const gebunden = ll !== null && ll.length > 0 && ll === row.lastActivityExakt;
  // Bisherige zeitliche Plausibilitaet separat erhalten: sie stellt niemals eine Laufbindung her.
  const plausibel = row.lastActivity instanceof Date && row.lastActivity.toJSON() !== null
    && row.beendetErkanntAm instanceof Date && row.beendetErkanntAm.toJSON() !== null
    && row.lastActivity <= row.beendetErkanntAm;
  const gueltig = hat && row.status === 'crashed' && gebunden && plausibel && pid !== null && pid === row.wrapperPid;
  const ev = gueltig && row.beendetDetails?.ereignis && typeof row.beendetDetails.ereignis === 'object'
    ? (row.beendetDetails.ereignis as { id?: unknown }).id : null;
  const beendet = gueltig ? { ursache: row.beendetUrsache!, erkannt_am: row.beendetErkanntAm ? row.beendetErkanntAm.toISOString() : null,
    ereignis_id: typeof ev === 'string' ? ev : null } : null;
  const anzeige: WrapperAnzeigeStatus = row.status === 'crashed' && beendet && NEUSTART_URSACHEN.includes(beendet.ursache) ? 'beendet_durch_neustart' : row.status;
  return { anzeige_status: anzeige, beendet, veraltet_verworfen: hat && !gueltig };
}

export async function wrapperStatusUrsacheAktiv(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(WRAPPER_STATUS_URSACHE_FUNKTION, project)).aktiv; } catch { return false; }
}

export const RUNTIME_UEBERSICHT_FUNKTION = 'runtime_agenten_uebersicht' as const;
/** Ab diesem Alter der letzten Aktivitaet gilt ein 'running'/'idle'-Agent als veraltet (Env SYNAPSE_RUNTIME_VERALTET_MS, Std 10 min). */
/** R8: Schwelle aus PG-Einstellung runtime_veraltet_minuten (zuletzt gelesen), sonst Code-Standard 10 min. Kein ENV-Weg. */
export function runtimeVeraltetMs(): number {
  return runtimeAgentenGrenzenJetzt().veraltet_ms;
}

export type RuntimeWarnung = 'crashed' | 'beendet_durch_neustart' | 'laeuft_veraltet' | 'laeuft_ohne_heartbeat_und_auftrag' | 'busy_veraltet';

export interface RuntimeAgentEintrag {
  name: string;
  identity_id: string | null;
  quelle: 'identitaet' | 'legacy';
  ort: 'container' | 'pc' | 'unbekannt';
  runtime: string | null;
  status: WrapperStatusRow['status'];
  busy: boolean;
  letzte_aktivitaet: string;
  inaktiv_sekunden: number;
  heartbeat: { an: boolean; takt_ms: number | null };
  pid: number | null;
  wrapper_pid: number | null;
  modell: string | null;
  auftrag: string | null;
  tokens: { input: number; output: number; prozent: number; decke: number | null };
  warnungen: RuntimeWarnung[];
  /** P22-T125 (nur Schalter wrapper_status_ursache EIN). */
  anzeige_status?: WrapperAnzeigeStatus;
  beendet?: (WrapperEndeAnzeige['beendet'] & { veraltet_verworfen?: boolean }) | { veraltet_verworfen: true } | null;
  du_selbst?: boolean;
}

export interface RuntimeUebersicht {
  orte: Record<string, RuntimeAgentEintrag[]>;
  anzahl: number;
  warnungen_gesamt: number;
}

/** Ort aus Startort (T113) bzw. Socket-Pfad: Container-Wrapper laufen unter /root/.synapse/agent-runs/. */
export function ortFuer(row: Pick<WrapperStatusRow, 'socketPath' | 'provider'>, startOrt?: { start_ort: string | null; start_ziel: string | null } | null): { ort: RuntimeAgentEintrag['ort']; runtime: string | null } {
  if (startOrt?.start_ort === 'container') return { ort: 'container', runtime: startOrt.start_ziel ?? null };
  if (startOrt?.start_ort === 'daemon') return { ort: 'pc', runtime: startOrt.start_ziel ?? null };
  const s = row.socketPath ?? '';
  if (s.startsWith('/root/.synapse/agent-runs/')) return { ort: 'container', runtime: row.provider === 'openai' ? 'codex' : 'claude' };
  if (s) return { ort: 'pc', runtime: null };
  return { ort: 'unbekannt', runtime: null };
}

/** Warnungen fuer einen Eintrag (rein, testbar). */
export function warnungenFuer(row: WrapperStatusRow, jetzt: number, veraltetMs: number): RuntimeWarnung[] {
  const w: RuntimeWarnung[] = [];
  const alt = jetzt - row.lastActivity.getTime();
  if (row.status === 'crashed') w.push('crashed');
  const laeuft = row.status === 'running' || row.status === 'idle';
  if (laeuft && alt > veraltetMs) w.push(row.busy ? 'busy_veraltet' : 'laeuft_veraltet');
  if (laeuft && !row.heartbeatEnabled && !row.busy && !row.currentTask) w.push('laeuft_ohne_heartbeat_und_auftrag');
  return w;
}

/** Baut die Uebersicht je Ort/Runtime (rein, testbar). Schluessel: 'container:claude', 'pc', 'unbekannt' ... */
export function baueRuntimeUebersicht(rows: WrapperStatusRow[], opts: { jetzt?: number; veraltetMs?: number; startOrte?: Map<string, { start_ort: string | null; start_ziel: string | null }>;
  /** P22-T125: Schalter wrapper_status_ursache. */ ursache?: boolean; selbst_identity_id?: string | null } = {}): RuntimeUebersicht {
  const jetzt = opts.jetzt ?? Date.now();
  const veraltet = opts.veraltetMs ?? runtimeVeraltetMs();
  const orte: Record<string, RuntimeAgentEintrag[]> = {};
  let warnungen = 0;
  for (const row of rows) {
    const { ort, runtime } = ortFuer(row, row.identityId ? opts.startOrte?.get(row.identityId) : null);
    const e: RuntimeAgentEintrag = {
      name: row.agentName,
      identity_id: row.identityId ?? null,
      quelle: row.identityId ? 'identitaet' : 'legacy',
      ort, runtime,
      status: row.status,
      busy: row.busy,
      letzte_aktivitaet: row.lastActivity.toISOString(),
      inaktiv_sekunden: Math.max(0, Math.round((jetzt - row.lastActivity.getTime()) / 1000)),
      heartbeat: { an: row.heartbeatEnabled, takt_ms: row.heartbeatIntervalMs },
      pid: row.innerPid, wrapper_pid: row.wrapperPid,
      modell: row.modelFullId ?? row.model,
      auftrag: row.currentTask ? row.currentTask.slice(0, 200) : null,
      tokens: { input: row.tokensInput ?? 0, output: row.tokensOutput ?? 0, prozent: row.tokensPercent ?? 0, decke: row.contextCeiling },
      warnungen: warnungenFuer(row, jetzt, veraltet),
    };
    if (opts.ursache) {
      const a = wrapperEndeAnzeige(row);
      e.anzeige_status = a.anzeige_status;
      e.beendet = a.beendet ?? (a.veraltet_verworfen ? { veraltet_verworfen: true } : null);
      if (a.anzeige_status === 'beendet_durch_neustart') e.warnungen = e.warnungen.map(w => (w === 'crashed' ? 'beendet_durch_neustart' : w));
      e.du_selbst = !!opts.selbst_identity_id && row.identityId === opts.selbst_identity_id;
    }
    warnungen += e.warnungen.length;
    const k = runtime && ort !== 'unbekannt' ? ort + ':' + runtime : ort;
    (orte[k] ??= []).push(e);
  }
  return { orte, anzahl: rows.length, warnungen_gesamt: warnungen };
}

export async function runtimeUebersichtAktiv(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(RUNTIME_UEBERSICHT_FUNKTION, project)).aktiv; } catch { return false; }
}

async function leseStartOrte(ids: string[]): Promise<Map<string, { start_ort: string | null; start_ziel: string | null }>> {
  const m = new Map<string, { start_ort: string | null; start_ziel: string | null }>();
  if (!ids.length) return m;
  try {
    const r = await getPool().query<{ id: string; start_ort: string | null; start_ziel: string | null }>(
      'SELECT id::text AS id, start_ort, start_ziel FROM agent_identitaeten WHERE id::text = ANY($1::text[])', [ids]);
    for (const z of r.rows) m.set(z.id, { start_ort: z.start_ort, start_ziel: z.start_ziel });
  } catch { /* Spalten fehlen (vor Schema 149) -> Ableitung ueber Socket-Pfad */ }
  return m;
}

/** R1: Wrapper-Zeile genau dieser Identitaet aus ihrem Heimatprojekt (wirft nie, null = keine). */
async function leseEigeneWrapperZeile(identityId: string): Promise<WrapperStatusRow | null> {
  try {
    const r = await getPool().query<{ project: string }>('SELECT project FROM agent_identitaeten WHERE id::text = $1', [identityId]);
    const heimat = r.rows[0]?.project;
    if (!heimat) return null;
    return (await listWrapperStatus(heimat)).find(z => z.identityId === identityId) ?? null;
  } catch { return null; }
}

/** Uebersicht eines Projekts samt Debug. Schalter AUS -> null (Aufrufer bleibt beim Altverhalten). */
export async function leseRuntimeUebersicht(project: string, rows?: WrapperStatusRow[], o: { selbst_identity_id?: string | null } = {}): Promise<(RuntimeUebersicht & { debug: Record<string, unknown> }) | null> {
  if (!(await runtimeUebersichtAktiv(project))) return null;
  try {
    const grenzen = await leseRuntimeAgentenGrenzen();
    const alle = rows ?? await listWrapperStatus(project);
    const ids = alle.map(r => r.identityId).filter((x): x is string => !!x);
    const startOrte = await leseStartOrte(ids);
    // P22-T125: Aufrufer-Identitaet aus dem Ausweis-Kontext, falls nicht ausdruecklich uebergeben.
    const ursache = await wrapperStatusUrsacheAktiv(project);
    const p = aktuellerAgentPrincipal();
    const selbst = o.selbst_identity_id ?? (p && p.art === 'identity' ? p.identity_id : null);
    // R1 (rea4 27659184): die eigene Zeile des Aufrufers (z. B. Main mit Heimat synapse-hauptagent im Userprojekt) gezielt
    // nachladen - NUR die verifizierte eigene Identitaet, keine fremden Zeilen anderer Projekte.
    let zeilen = alle;
    let selbstNachgeladen = false;
    if (ursache && selbst && !alle.some(r => r.identityId === selbst)) {
      const eigen = await leseEigeneWrapperZeile(selbst);
      if (eigen) {
        zeilen = [...alle, eigen];
        selbstNachgeladen = true;
        const so = await leseStartOrte([selbst]);
        for (const [k, v] of so) startOrte.set(k, v);
      }
    }
    const u = baueRuntimeUebersicht(zeilen, { startOrte, ursache, selbst_identity_id: selbst });
    return { ...u, debug: { schalter: RUNTIME_UEBERSICHT_FUNKTION, wrapper_status_ursache: ursache, selbst_identity_id: ursache ? selbst : null, selbst_nachgeladen: selbstNachgeladen,
      zeilen_identitaet: ids.length, zeilen_legacy: alle.length - ids.length,
      start_orte_bekannt: [...startOrte.values()].filter(s => s.start_ort).length, veraltet_ms: grenzen.veraltet_ms, grenzen_quelle: grenzen.quelle } };
  } catch (err) {
    return { orte: {}, anzahl: 0, warnungen_gesamt: 0, debug: { schalter: RUNTIME_UEBERSICHT_FUNKTION, fehler: String((err as Error)?.message ?? err).slice(0, 200) } };
  }
}

/**
 * Namenssuche ueber BEIDE Tabellen (Legacy-Fehltreffer). Schalter AUS -> null. Bei mehreren Treffern gewinnt die juengste Aktivitaet.
 */
export async function findeWrapperStatusPerName(name: string, project: string): Promise<{ row: WrapperStatusRow; debug: Record<string, unknown> } | null> {
  if (!(await runtimeUebersichtAktiv(project))) return null;
  try {
    const treffer = (await listWrapperStatus(project)).filter(r => r.agentName === name);
    if (!treffer.length) return null;
    return { row: treffer[0], debug: { suchweg: 'name_ueber_identitaet_und_legacy', treffer: treffer.length, schalter: RUNTIME_UEBERSICHT_FUNKTION } };
  } catch { return null; }
}
