/**
 * P22-T118 (Befund t177: rea4 33f37e44, rea3 bfd46f34, Koordinator deae6113), korrigiert nach 7476d698: Ende eines Wrappers belegbar.
 * Bisher setzten daemon-jobs-vertrag (markiereWrapperAbgestuerzt) und wrapper-prozess (reapLokaleWrapper) status='crashed' ohne
 * Zeit und Ursache; last_activity wurde faelschlich als Crashzeitpunkt gelesen. Jetzt (rein additiv, Schema 150):
 *   beendet_erkannt_am  = wann das Ende ERKANNT wurde (der echte Todeszeitpunkt ist ohne Prozessbeleg unbekannt)
 *   beendet_ursache     = container_restart | container_start NUR mit Wrapper-Beleg: das Ereignis fuehrt genau diesen Wrapper
 *                         (Identitaet bzw. Agent+Projekt UND Wrapper-PID) in betroffene_wrapper. Sonst prozess_weg (= Prozess weg,
 *                         Ursache unbelegt); zeitlich passende Ereignisse ohne Beleg stehen nur als Hinweis details.zeitgleich.
 *                         wiederbelebung traegt keinen Betroffenen-Snapshot -> nie Ursache, hoechstens Hinweis.
 *   beendet_details     = letztes_lebenszeichen, Zeitfenster, Erkennungsquelle, Ort/Runtime, belegtes Ereignis bzw. Hinweise.
 * Gegenrichtung: das Container-Ereignis traegt die zum Massnahmenzeitpunkt laufenden Wrapper (betroffeneWrapper, mit Vollstaendigkeit).
 * GRENZEN (Regel 7, PG-Katalog runtime_ueberwachung): wrapper_ende_fenster_minuten (30), wrapper_ende_betroffene_max (50).
 * Wirft nie; Schreib-/Schemafehler werden geloggt ([wrapper-ende]) und im debug geliefert.
 */
import { getPool } from '../db/client.js';
import { ortFuer } from './runtime-agenten-uebersicht.js';

/** Ereignisarten mit Betroffenen-Snapshot (koennen belegte Ursache sein). */
export const CONTAINER_ENDE_ARTEN = ['container_restart', 'container_start'] as const;
/** Nur Hinweis (kein Snapshot). */
export const CONTAINER_HINWEIS_ARTEN = ['wiederbelebung'] as const;
/** Code-Standards; wirksam sind die PG-Einstellungen (leseWrapperEndeGrenzen). */
export const WRAPPER_ENDE_STANDARD = { fenster_ms: 30 * 60_000, betroffene_max: 50 } as const;
/** @deprecated Code-Standard, siehe WRAPPER_ENDE_STANDARD. */
export const WRAPPER_ENDE_FENSTER_MS = WRAPPER_ENDE_STANDARD.fenster_ms;

export interface BetroffenerWrapper { identity_id: string | null; agent: string; project: string; wrapper_pid: number | null; status?: string; last_activity?: string | null }
export interface UeberwachungsEreignisKurz { id: string; zeit: string; art: string; ursache: string | null; betroffene_wrapper?: BetroffenerWrapper[] | null; betroffene_gekappt?: boolean | null }
export interface WrapperEndeZiel { identity_id: string | null; agent: string; project: string; wrapper_pid: number }
export interface WrapperEndeBefund {
  ursache: 'container_restart' | 'container_start' | 'prozess_weg';
  /** Belegtes Ereignis (Ziel steht in betroffene_wrapper). */
  ereignis: UeberwachungsEreignisKurz | null;
  beleg: 'betroffene_wrapper' | null;
  /** Zeitlich passende Ereignisse OHNE Beleg fuer genau diesen Wrapper - nur Hinweis, keine Ursache. */
  zeitgleich: Array<{ id: string; zeit: string; art: string; grund: 'anderer_wrapper' | 'kein_snapshot' | 'snapshot_gekappt' }>;
  fenster: { von: string | null; bis: string };
}

export async function leseWrapperEndeGrenzen(): Promise<{ fenster_ms: number; betroffene_max: number; quelle: 'pg' | 'standard' }> {
  try {
    const { leseRuntimeUeberwachungWerte } = await import('./runtime-ueberwachung.js');
    const w = await leseRuntimeUeberwachungWerte() as unknown as Record<string, unknown>;
    const f = Number(w.wrapper_ende_fenster_minuten), m = Number(w.wrapper_ende_betroffene_max);
    return { fenster_ms: Number.isFinite(f) && f > 0 ? Math.floor(f * 60_000) : WRAPPER_ENDE_STANDARD.fenster_ms,
      betroffene_max: Number.isFinite(m) && m > 0 ? Math.floor(m) : WRAPPER_ENDE_STANDARD.betroffene_max, quelle: 'pg' };
  } catch { return { ...WRAPPER_ENDE_STANDARD, quelle: 'standard' }; }
}

/** Rein: steht genau dieser Wrapper (Identitaet bzw. Agent+Projekt UND PID) im Snapshot? */
export function zielBetroffen(ziel: WrapperEndeZiel, liste: BetroffenerWrapper[] | null | undefined): boolean {
  if (!Array.isArray(liste)) return false;
  return liste.some(b => b.wrapper_pid === ziel.wrapper_pid && b.project === ziel.project
    && (ziel.identity_id ? b.identity_id === ziel.identity_id : (!b.identity_id && b.agent === ziel.agent)));
}

/**
 * Rein, testbar: Ursache des erkannten Wrapper-Endes. Definitiv nur mit Wrapper-Beleg im Ereignis (und Ereignis nach dem letzten
 * Lebenszeichen, vor der Erkennung). Zeitlich passende Ereignisse ohne Beleg (fremde Identitaet/PID, kein oder gekappter Snapshot)
 * erscheinen nur unter zeitgleich.
 */
export function bewerteWrapperEnde(e: { ziel: WrapperEndeZiel; letztes_lebenszeichen: string | null; erkannt_am: string; ereignisse: UeberwachungsEreignisKurz[]; fenster_ms?: number }): WrapperEndeBefund {
  const bis = Date.parse(e.erkannt_am);
  const von = e.letztes_lebenszeichen ? Date.parse(e.letztes_lebenszeichen) : NaN;
  const fenster = e.fenster_ms ?? WRAPPER_ENDE_STANDARD.fenster_ms;
  const imFenster = (x: UeberwachungsEreignisKurz) => {
    const t = Date.parse(x.zeit);
    return Number.isFinite(t) && t <= bis && (Number.isFinite(von) ? t >= von && t - von <= fenster : bis - t <= fenster);
  };
  const kandidaten = e.ereignisse
    .filter(x => (CONTAINER_ENDE_ARTEN as readonly string[]).includes(x.art) || (CONTAINER_HINWEIS_ARTEN as readonly string[]).includes(x.art))
    .filter(imFenster).sort((a, b) => Date.parse(b.zeit) - Date.parse(a.zeit));
  const belegt = kandidaten.find(x => (CONTAINER_ENDE_ARTEN as readonly string[]).includes(x.art) && zielBetroffen(e.ziel, x.betroffene_wrapper)) ?? null;
  const zeitgleich = kandidaten.filter(x => x !== belegt).map(x => ({ id: x.id, zeit: x.zeit, art: x.art,
    grund: (!Array.isArray(x.betroffene_wrapper) ? 'kein_snapshot' : x.betroffene_gekappt ? 'snapshot_gekappt' : 'anderer_wrapper') as WrapperEndeBefund['zeitgleich'][number]['grund'] }));
  return { ursache: belegt ? belegt.art as WrapperEndeBefund['ursache'] : 'prozess_weg', ereignis: belegt, beleg: belegt ? 'betroffene_wrapper' : null,
    zeitgleich, fenster: { von: e.letztes_lebenszeichen, bis: e.erkannt_am } };
}

/** Nach einem erfolgreichen crashed-UPDATE: Ende mit Erkennungszeit, Ursache (nur belegt) und Ereignis-Verknuepfung. Wirft nie. */
export async function vermerkeWrapperEnde(k: { identity_id?: string | null; project: string; agent_name: string; wrapper_pid: number; last_activity: string | null; quelle: string }): Promise<{ geschrieben: boolean; befund: WrapperEndeBefund | null; debug: Record<string, unknown> }> {
  const tabelle = k.identity_id ? 'agent_identitaet_wrapper_status' : 'wrapper_status';
  const schluessel = k.identity_id ? 'identity_id' : 'agent_name';
  try {
    const pool = getPool();
    const grenzen = await leseWrapperEndeGrenzen();
    const z = await pool.query<{ socket_path: string | null; provider: string | null; last_activity: Date | null }>(
      `SELECT socket_path, provider, last_activity FROM ${tabelle} WHERE project=$1 AND ${schluessel}=$2 AND wrapper_pid=$3 LIMIT 1`, [k.project, k.identity_id ?? k.agent_name, k.wrapper_pid]);
    const o = ortFuer({ socketPath: z.rows[0]?.socket_path ?? null, provider: z.rows[0]?.provider ?? null });
    const erkannt = new Date().toISOString();
    let ereignisse: UeberwachungsEreignisKurz[] = [];
    if (o.ort === 'container' && o.runtime) {
      const r = await pool.query<{ id: string; zeit: Date; art: string; ursache: string | null; details: Record<string, unknown> | null }>(
        `SELECT id::text AS id, zeit, art, ursache, details FROM runtime_ueberwachung_ereignisse WHERE runtime=$1 AND art = ANY($2::text[])
           AND zeit <= NOW() AND zeit >= NOW() - make_interval(secs => $3) ORDER BY zeit DESC LIMIT 50`,
        [o.runtime, [...CONTAINER_ENDE_ARTEN, ...CONTAINER_HINWEIS_ARTEN], Math.round(grenzen.fenster_ms / 1000) * 2]);
      ereignisse = r.rows.map(x => ({ id: x.id, zeit: x.zeit.toISOString(), art: x.art, ursache: x.ursache,
        betroffene_wrapper: Array.isArray(x.details?.betroffene_wrapper) ? x.details!.betroffene_wrapper as BetroffenerWrapper[] : null,
        betroffene_gekappt: x.details?.betroffene_gekappt === true }));
    }
    const ziel: WrapperEndeZiel = { identity_id: k.identity_id ?? null, agent: k.agent_name, project: k.project, wrapper_pid: k.wrapper_pid };
    const befund = bewerteWrapperEnde({ ziel, letztes_lebenszeichen: z.rows[0]?.last_activity ? z.rows[0].last_activity.toISOString() : null, erkannt_am: erkannt, ereignisse, fenster_ms: grenzen.fenster_ms });
    const ev = befund.ereignis ? { id: befund.ereignis.id, zeit: befund.ereignis.zeit, art: befund.ereignis.art, ursache: befund.ereignis.ursache } : null;
    const details = { letztes_lebenszeichen: befund.fenster.von, zeitfenster: befund.fenster, zeitpunkt: 'erkannt_nicht_gemessen', quelle: k.quelle,
      ort: o.ort, runtime: o.ort === 'container' ? o.runtime : null, wrapper_pid: k.wrapper_pid, ereignis: ev, beleg: befund.beleg, zeitgleich: befund.zeitgleich,
      grenzen: { fenster_ms: grenzen.fenster_ms, quelle: grenzen.quelle } };
    const u = await pool.query(
      `UPDATE ${tabelle} SET beendet_erkannt_am=$5::timestamptz, beendet_ursache=$6, beendet_details=$7::jsonb
        WHERE project=$1 AND ${schluessel}=$2 AND wrapper_pid=$3 AND status='crashed' AND ($4::text IS NULL OR last_activity=$4::timestamptz)`,
      [k.project, k.identity_id ?? k.agent_name, k.wrapper_pid, k.last_activity, erkannt, befund.ursache, JSON.stringify(details)]);
    const geschrieben = (u.rowCount ?? 0) > 0;
    if (!geschrieben) console.error(`[wrapper-ende] nicht vermerkt (${tabelle}, ${k.identity_id ?? k.agent_name}, PID ${k.wrapper_pid}): Zeile nicht mehr crashed/CAS`);
    return { geschrieben, befund, debug: { tabelle, ort: o.ort, runtime: o.runtime, grenzen } };
  } catch (err) {
    const fehler = String((err as Error)?.message ?? err).slice(0, 200);
    console.error(`[wrapper-ende] nicht vermerkt (${tabelle}, ${k.identity_id ?? k.agent_name}, PID ${k.wrapper_pid}): ${fehler}`);
    return { geschrieben: false, befund: null, debug: { tabelle, fehler } };
  }
}

/** Gegenrichtung fuer das Container-Ereignis: zur Massnahme laufende Wrapper dieses Containers, mit Vollstaendigkeit. Wirft nie. */
export async function betroffeneWrapper(runtime: string): Promise<{ liste: BetroffenerWrapper[]; gesamt: number; gekappt: boolean; max: number; fehler: string | null }> {
  const { betroffene_max: max } = await leseWrapperEndeGrenzen();
  try {
    const r = await getPool().query<{ identity_id: string | null; agent_name: string; project: string; wrapper_pid: number | null; status: string; socket_path: string | null; provider: string | null; last_activity: Date | null }>(
      `SELECT identity_id::text AS identity_id, agent_name, project, wrapper_pid, status, socket_path, provider, last_activity
         FROM agent_identitaet_wrapper_status WHERE status IN ('running','idle')`);
    const alle = r.rows.filter(x => { const o = ortFuer({ socketPath: x.socket_path, provider: x.provider }); return o.ort === 'container' && o.runtime === runtime; });
    return { gesamt: alle.length, gekappt: alle.length > max, max, fehler: null,
      liste: alle.slice(0, max).map(x => ({ identity_id: x.identity_id, agent: x.agent_name, project: x.project, wrapper_pid: x.wrapper_pid, status: x.status, last_activity: x.last_activity ? x.last_activity.toISOString() : null })) };
  } catch (err) { return { liste: [], gesamt: 0, gekappt: false, max, fehler: String((err as Error)?.message ?? err).slice(0, 200) }; }
}
