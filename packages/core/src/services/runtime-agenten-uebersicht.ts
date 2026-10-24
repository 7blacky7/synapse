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

export const RUNTIME_UEBERSICHT_FUNKTION = 'runtime_agenten_uebersicht' as const;
/** Ab diesem Alter der letzten Aktivitaet gilt ein 'running'/'idle'-Agent als veraltet (Env SYNAPSE_RUNTIME_VERALTET_MS, Std 10 min). */
export function runtimeVeraltetMs(): number {
  const n = Number(process.env.SYNAPSE_RUNTIME_VERALTET_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10 * 60_000;
}

export type RuntimeWarnung = 'crashed' | 'laeuft_veraltet' | 'laeuft_ohne_heartbeat_und_auftrag' | 'busy_veraltet';

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
export function baueRuntimeUebersicht(rows: WrapperStatusRow[], opts: { jetzt?: number; veraltetMs?: number; startOrte?: Map<string, { start_ort: string | null; start_ziel: string | null }> } = {}): RuntimeUebersicht {
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

/** Uebersicht eines Projekts samt Debug. Schalter AUS -> null (Aufrufer bleibt beim Altverhalten). */
export async function leseRuntimeUebersicht(project: string, rows?: WrapperStatusRow[]): Promise<(RuntimeUebersicht & { debug: Record<string, unknown> }) | null> {
  if (!(await runtimeUebersichtAktiv(project))) return null;
  try {
    const alle = rows ?? await listWrapperStatus(project);
    const ids = alle.map(r => r.identityId).filter((x): x is string => !!x);
    const startOrte = await leseStartOrte(ids);
    const u = baueRuntimeUebersicht(alle, { startOrte });
    return { ...u, debug: { schalter: RUNTIME_UEBERSICHT_FUNKTION, zeilen_identitaet: ids.length, zeilen_legacy: alle.length - ids.length,
      start_orte_bekannt: [...startOrte.values()].filter(s => s.start_ort).length, veraltet_ms: runtimeVeraltetMs() } };
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
