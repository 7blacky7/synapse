/**
 * P22-T113 Stufe 2 (User 24.10.2026): Die API NUTZT den Startort. Nachrichten an Agenten (inbox, chat, channel, event)
 * bekommt der Daemon des Startorts und stellt sie dem Agenten direkt zu - wie eine Direktnachricht vom User.
 * HEARTBEAT (Korrektur User 24.10.): wird hier NIE angefasst. Er bleibt je Agent so, wie User/Koordinator/Main ihn bewusst
 *   gesetzt haben (specialist heartbeat, admin koordinator_heartbeat); die Zustellung laeuft unabhaengig davon.
 * ABLAUF (Takt im API-Prozess, agent-runtime/manager.ts zustellTakt):
 *   Kandidaten = aktive Identitaeten (nicht der Main, der hat seinen eigenen Weg) mit lebendem Wrapper und start_ort
 *   container (Runtime claude|codex -> target_runtime) bzw. daemon (PC-Host -> target_hostname). extern, kein Host,
 *   Schalter AUS: nichts (bisheriger Weg). Erstuebernahme verlustfrei: bereits wartende inbox/event zuerst (Abnahme R4).
 *   Je Identitaet nie parallel.
 * EINSTELLUNGEN (Abnahme R6): PG-Katalog runtime_ueberwachung: startort_zustell_takt_sekunden (Standard 5) und
 *   startort_zustell_je_takt (Standard 3), setzbar ueber admin runtime_ueberwachung einstellungen; ENV
 *   SYNAPSE_STARTORT_ZUSTELL_MS nur Rueckfall, wenn PG nicht lesbar ist.
 * SCHALTER: agent_start_ort (je Projekt/global, Standard AUS). DEBUG: letzterStartOrtZustellStand() je Agent (Weg,
 *   Ergebnis/Fehler) samt Werten und deren Quelle.
 */
import { getPool } from '../db/client.js';
import { startOrtSchalterAktiv } from './agent-start-ort.js';
import { fuehreIdentitaetsZustellungAus, leseZustellOptionen, type ZustellErgebnis } from './hauptagent-zustellung.js';
import { SPECIALIST_ZIEL_RUNTIMES, type SpecialistZielRuntime } from './specialist-queue.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';

const laufend = new Set<string>();
let letzterStart = 0;
let werteCache: { am: number; takt_ms: number; je_takt: number; quelle: 'pg' | 'env' | 'standard' } | null = null;

/** Abstand/Menge aus PG (runtime_ueberwachung-Einstellungen), 30 s gecacht; ENV nur als Rueckfall bei Lesefehler. */
export async function leseStartOrtZustellWerte(jetzt = Date.now(), frisch = false): Promise<{ takt_ms: number; je_takt: number; quelle: 'pg' | 'env' | 'standard' }> {
  if (!frisch && werteCache && jetzt - werteCache.am < 30_000) return werteCache;
  try {
    const { leseRuntimeUeberwachungWerte } = await import('./runtime-ueberwachung.js');
    const w = await leseRuntimeUeberwachungWerte() as unknown as Record<string, unknown>;
    werteCache = { am: jetzt, takt_ms: Number(w.startort_zustell_takt_sekunden ?? 5) * 1000, je_takt: Number(w.startort_zustell_je_takt ?? 3), quelle: 'pg' };
  } catch {
    const env = Number(process.env.SYNAPSE_STARTORT_ZUSTELL_MS);
    const ok = Number.isFinite(env) && env >= 1000;
    werteCache = { am: jetzt, takt_ms: ok ? env : 5_000, je_takt: 3, quelle: ok ? 'env' : 'standard' };
  }
  return werteCache;
}

export interface StartOrtZustellAgent {
  identity_id: string; agent_id: string; project: string;
  weg: 'container_daemon' | 'pc_daemon' | 'bisheriger_weg' | 'laeuft_noch' | 'schalter_aus';
  ergebnis?: ZustellErgebnis; fehler?: string;
}
export interface StartOrtZustellStand { am: string; werte: { takt_ms: number; je_takt: number; quelle: string }; kandidaten: number; agenten: StartOrtZustellAgent[] }
let letzter: StartOrtZustellStand | null = null;

export function letzterStartOrtZustellStand(): StartOrtZustellStand | null { return letzter; }

function zielFuer(start_ort: string | null, start_ziel: string | null): { target_runtime: SpecialistZielRuntime } | { target_hostname: string } | null {
  if (start_ort === 'container') return (SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(start_ziel ?? '') ? { target_runtime: start_ziel as SpecialistZielRuntime } : null;
  if (start_ort === 'daemon') return start_ziel ? { target_hostname: start_ziel } : null;
  return null;
}

interface Kandidat { id: string; project: string; agent_id: string; start_ort: string; start_ziel: string | null }

/** Ein Takt. Wirft nie; wartet auf alle gestarteten Zustellungen (Aufrufer startet ihn ohne await). */
export async function fuehreStartOrtZustellungenAus(jetzt = Date.now()): Promise<StartOrtZustellStand | null> {
  const werte = await leseStartOrtZustellWerte(jetzt);
  if (jetzt - letzterStart < werte.takt_ms) return null;
  letzterStart = jetzt;
  try {
    const r = await getPool().query<Kandidat>(
      `SELECT i.id, i.project, i.agent_id, i.start_ort, i.start_ziel
         FROM agent_identitaeten i JOIN agent_identitaet_wrapper_status w ON w.identity_id = i.id AND w.project = i.project
        WHERE i.start_ort IN ('container','daemon') AND i.status = 'aktiv' AND i.rolle <> 'main' AND i.project <> $1
          AND w.status IN ('running','idle')`, [HAUPTAGENT_PROJEKT]);
    const schalter = new Map<string, Promise<boolean>>();
    const an = (p: string) => { if (!schalter.has(p)) schalter.set(p, startOrtSchalterAktiv(p)); return schalter.get(p)!; };
    const opt = { ...leseZustellOptionen(), aktiv: true };
    const agenten = await Promise.all(r.rows.map(async (z): Promise<StartOrtZustellAgent> => {
      const basis = { identity_id: z.id, agent_id: z.agent_id, project: z.project };
      if (!(await an(z.project))) return { ...basis, weg: 'schalter_aus' };
      const ziel = zielFuer(z.start_ort, z.start_ziel);
      if (!ziel) return { ...basis, weg: 'bisheriger_weg' };
      const weg = z.start_ort === 'container' ? 'container_daemon' as const : 'pc_daemon' as const;
      if (laufend.has(z.id)) return { ...basis, weg: 'laeuft_noch' };
      laufend.add(z.id);
      try {
        const ergebnis = await fuehreIdentitaetsZustellungAus({ identity_id: z.id, project: z.project, agent_id: z.agent_id, ziel, optionen: opt, max: werte.je_takt });
        return { ...basis, weg, ergebnis };
      } catch (err) {
        return { ...basis, weg, fehler: ((err as Error).message ?? 'fehler').slice(0, 200) };
      } finally {
        laufend.delete(z.id);
      }
    }));
    letzter = { am: new Date(jetzt).toISOString(), werte: { takt_ms: werte.takt_ms, je_takt: werte.je_takt, quelle: werte.quelle }, kandidaten: r.rows.length, agenten };
    return letzter;
  } catch (err) {
    console.error('[startort-zustellung] Takt:', (err as Error).message);
    return null;
  }
}
