/**
 * P22-T6 (W2c): Chat-Turn ueber den dauerhaften Hauptagenten im Runtime-Container (Container-Daemon -> Wrapper -> CLI-Kind,
 * wie ein lokaler Spezialist; core hauptagent-lauf.ts). Gemeinsam fuer den Claude- und den Codex-Treiber (P22-T6b).
 * Nur bei Schalter hauptagent EIN und einer Session der Main-Identitaet. Ohne angemeldeten Runtime-Daemon: Altweg des
 * Treibers (docker exec je Turn) mit sichtbarem Hinweis bzw. Fehler, je nach SYNAPSE_HAUPTAGENT_OHNE_DAEMON (O3).
 * Rueckgabe null = Altweg benutzen.
 */
import {
  leseHauptagentSchalter, hauptagentIdentitaetsId, leseMainLaufOptionen, runtimeDaemonAngemeldet, stelleMainLaufSicher,
  sendeMainTurn, MainLaufFehler, leseMainLauf, standardModellFuerRuntime, type SpecialistZielRuntime,
} from '@synapse/core';
import type { MainAgentSession, RuntimeMessageResult, RuntimeStreamEvent } from './types.js';
import { merkeMainTurnSession, vergissMainTurnSession } from './artifact-stream.js';

/** P22-T66: letzter Fehler des dauerhaften Main-Wegs (Code + Ursache) fuer das Debug von GET /api/main-agent/status. */
export interface MainWegFehler { zeit: string; runtime: string; code: string; meldung: string | null }
let letzterFehler: MainWegFehler | null = null;
export function letzterMainWegFehler(): MainWegFehler | null {
  return letzterFehler;
}

export async function dauerhafterMainTurn(
  runtime: SpecialistZielRuntime, session: MainAgentSession, message: string, modell: string,
  emit: (event: RuntimeStreamEvent) => void,
): Promise<RuntimeMessageResult | null> {
  if (!session.identityId) return null;
  try {
    if (!(await leseHauptagentSchalter()).aktiv) return null;
    if ((await hauptagentIdentitaetsId()) !== session.identityId) return null;
  } catch {
    return null;
  }
  const optionen = leseMainLaufOptionen();
  if (!(await runtimeDaemonAngemeldet(runtime))) {
    if (optionen.ohne_daemon === 'fehler') throw new Error('Runtime-Daemon im Container ist nicht angemeldet (runtime_daemon_fehlt)');
    emit({ event: 'runtime', data: { hauptagent: { weg: 'altweg', hinweis: 'runtime_daemon_fehlt' } } });
    return null;
  }
  try {
    emit({ event: 'runtime', data: { hauptagent: { weg: 'dauerhaft', identity_id: session.identityId, schritt: 'start_pruefen' } } });
    // P22-T62: Start noetig -> Standard aus core (Schalter hauptagent_cli_modelle EIN: User-Wahl der Runtime bzw. kleinstes
    // Modell der CLI-Liste; AUS: das uebergebene Treiber-Modell). Ein konfiguriertes Profil-Modell geht in stelleMainLaufSicher vor.
    // P22-T70: die User-Wahl ist ausdruecklich und geht vor dem Profil-Modell (modell_bestaetigt) in stelleMainLaufSicher.
    let startModell = modell;
    let modellExplizit = false;
    if ((await leseMainLauf(session.identityId)).zustand !== 'laeuft') {
      const w = await standardModellFuerRuntime(runtime, async () => modell);
      if (!w.modell) throw new MainLaufFehler('standardmodell_unbestimmt', { runtime, grund: w.grund });
      startModell = w.modell;
      modellExplizit = w.quelle === 'user_wahl';
    }
    const start = await stelleMainLaufSicher({ identity_id: session.identityId, runtime, modell: startModell, modell_explizit: modellExplizit });
    if (start.zustand !== 'laeuft') throw new MainLaufFehler('main_start_dauert', { spawn_job_id: start.spawn_job_id });
    emit({ event: 'runtime', data: { hauptagent: { weg: 'dauerhaft', schritt: 'arbeitet', neu_gestartet: start.neu } } });
    // P22-T70: artefakt-Aufrufe des Main (Session 'identitaet-<id>') waehrend dieses Turns landen in dieser Chat-Session.
    merkeMainTurnSession(session.identityId, session.id);
    let r: Awaited<ReturnType<typeof sendeMainTurn>>;
    try {
      r = await sendeMainTurn({ identity_id: session.identityId, runtime, nachricht: message, optionen });
    } finally {
      vergissMainTurnSession(session.identityId, session.id);
    }
    if (r.art === 'zugestellt') {
      emit({ event: 'runtime', data: { hauptagent: { weg: 'dauerhaft', schritt: 'zugestellt', hinweis: r.hinweis } } });
      emit({ event: 'delta', data: { content: r.hinweis } });
    } else {
      // O1: fertige Antwort (Live-Deltas folgen mit dem Delta-Weg des Wrappers).
      if (r.text) emit({ event: 'delta', data: { content: r.text } });
      emit({ event: 'usage', data: r.usage });
    }
    return { runtimeSessionId: session.runtimeSessionId, context: { ...(session.context ?? {}), hauptagent_weg: 'dauerhaft' } };
  } catch (error) {
    const code = error instanceof MainLaufFehler ? error.code : 'main_lauf_fehler';
    // P22-T66: Ursache (z. B. "CLI-Start fehlgeschlagen: ..." aus dem Wrapper) mitgeben statt nur des Codes.
    const roh = error instanceof MainLaufFehler ? error.details?.meldung : (error as Error)?.message;
    const meldung = typeof roh === 'string' && roh.trim() ? roh.trim().slice(0, 500) : null;
    letzterFehler = { zeit: new Date().toISOString(), runtime, code, meldung };
    throw new Error('Hauptagent im Container nicht erreichbar (' + code + ')' + (meldung ? ': ' + meldung : ''));
  }
}
