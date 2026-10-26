/**
 * P22-T6 (W2c): Chat-Turn ueber den dauerhaften Hauptagenten im Runtime-Container (Container-Daemon -> Wrapper -> CLI-Kind,
 * wie ein lokaler Spezialist; core hauptagent-lauf.ts). Gemeinsam fuer den Claude- und den Codex-Treiber (P22-T6b).
 * Nur bei Schalter hauptagent EIN und einer Session der Main-Identitaet. Ohne angemeldeten Runtime-Daemon: Altweg des
 * Treibers (docker exec je Turn) mit sichtbarem Hinweis bzw. Fehler, je nach SYNAPSE_HAUPTAGENT_OHNE_DAEMON (O3).
 * Rueckgabe null = Altweg benutzen.
 */
import {
  leseHauptagentSchalter, hauptagentIdentitaetsId, leseMainLaufOptionen, runtimeDaemonAngemeldet, stelleMainLaufSicher,
  sendeMainTurn, MainLaufFehler, leseMainLauf, standardModellFuerRuntime, warteschlangeAktiv, type SpecialistZielRuntime,
  getPool, HAUPTAGENT_PROJEKT, apiProviderFuerModell, leseApiLaufSchalter, legeApiLaufAn, legeApiEingangAn,
} from '@synapse/core';
import type { MainAgentSession, RuntimeMessageResult, RuntimeStreamEvent } from './types.js';
import { merkeMainTurnSession, vergissMainTurnSession } from './artifact-stream.js';

/** P22-T66: letzter Fehler des dauerhaften Main-Wegs (Code + Ursache) fuer das Debug von GET /api/main-agent/status. */
export interface MainWegFehler { zeit: string; runtime: string; code: string; meldung: string | null }
let letzterFehler: MainWegFehler | null = null;
export function letzterMainWegFehler(): MainWegFehler | null {
  return letzterFehler;
}

/** Wartezeit des Web-UI-Chats auf einen API-Turn des Main; danach steht die Antwort im Verlauf, sobald der Turn endet. */
const API_MAIN_WARTE_MS = 10 * 60_000;

async function apiLaufMainTurn(
  session: MainAgentSession, message: string, modell: string, emit: (event: RuntimeStreamEvent) => void,
): Promise<RuntimeMessageResult | null> {
  const identityId = session.identityId;
  if (!identityId) return null;
  const anbieter = await apiProviderFuerModell(modell).catch(() => null);
  if (!anbieter || !(await leseApiLaufSchalter(HAUPTAGENT_PROJEKT)).aktiv) return null;
  const { apiAgentLauf } = await import('../api-agent-lauf.js');
  const verwaltung = apiAgentLauf();
  if (!verwaltung) {
    throw Object.assign(new Error('Hauptagent per API-Lauf nicht moeglich (api_lauf_aus): Lauf-Verwaltung laeuft nicht (SYNAPSE_API_AGENTEN_LAUF_DISABLED)'),
      { code: 'api_lauf_aus', meldung: null });
  }
  // Rueckfall auf Container (Tageslimit erschoepft, User-Korrektur 26.10.): kein automatischer Rueckwechsel -> Bestand.
  const vorher = await getPool().query<{ status: string; letzter_fehler: string | null }>(
    'SELECT status, letzter_fehler FROM api_agent_laeufe WHERE identity_id = $1', [identityId]).catch(() => null);
  const z = vorher?.rows[0];
  if (z && z.status === 'gestoppt' && (z.letzter_fehler ?? '').startsWith('rueckfall_container:')) return null;
  const i = await getPool().query<{ agent_id: string }>('SELECT agent_id FROM agent_identitaeten WHERE id = $1', [identityId]);
  await legeApiLaufAn({ identity_id: identityId, project: HAUPTAGENT_PROJEKT, agent_id: i.rows[0]?.agent_id ?? 'hauptagent', rolle: 'main', modell, anbieter,
    gestartet_von: 'user' });
  emit({ event: 'runtime', data: { hauptagent: { weg: 'api_lauf', identity_id: identityId, modell, anbieter, schritt: 'arbeitet' } } });
  const eingang = await legeApiEingangAn({ identity_id: identityId, text: message, quelle: 'main_chat', absender: 'user' });
  const r = await verwaltung.warteAufEingang(eingang.id, API_MAIN_WARTE_MS);
  if (r.art === 'nicht_begonnen' && r.code === 'rueckfall_container') {
    // Tageslimit gerade erschoepft: Rueckfall, diese Nachricht geht ueber den Container-Main (Bestand) des Aufrufers.
    emit({ event: 'runtime', data: { hauptagent: { weg: 'ruckfall_container', identity_id: identityId, grund: 'budget_erschoepft' } } });
    return null;
  }
  if (r.art === 'nicht_begonnen') {
    letzterFehler = { zeit: new Date().toISOString(), runtime: 'api-lauf', code: r.code, meldung: null };
    throw Object.assign(new Error('Hauptagent per API-Lauf nicht moeglich (' + r.code + ')'), { code: r.code, meldung: null });
  }
  if (r.art === 'zeit') {
    emit({ event: 'delta', data: { content: 'Der Hauptagent arbeitet noch (API-Lauf); die Antwort folgt, sobald der Turn endet.' } });
  } else {
    if (r.text) emit({ event: 'delta', data: { content: r.text } });
    emit({ event: 'usage', data: { input_tokens: r.input_tokens, output_tokens: r.output_tokens, kosten_usd: r.kosten_usd, ende: r.ende } });
  }
  return { runtimeSessionId: session.runtimeSessionId, context: { ...(session.context ?? {}), hauptagent_weg: 'api_lauf' } };
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
  // P22-T183 B7b: API-Modell + Schalter api_agenten_lauf_intern EIN -> Turn IM API-Prozess statt Container-Job; sonst Bestand.
  const apiTurn = await apiLaufMainTurn(session, message, modell, emit);
  if (apiTurn) return apiTurn;
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
    if ((await leseMainLauf(session.identityId, runtime)).zustand !== 'laeuft') {
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
      try {
        r = await sendeMainTurn({ identity_id: session.identityId, runtime, nachricht: message, optionen, absender: 'user' });
      } catch (error) {
        // P22-T71: Wrapper weg (verwaist, halber Wechsel): einmal neu sicherstellen und erneut senden statt 'nicht verbunden'.
        if (!(error instanceof MainLaufFehler) || !['main_nicht_verbunden', 'main_laeuft_nicht'].includes(error.code)) throw error;
        emit({ event: 'runtime', data: { hauptagent: { weg: 'dauerhaft', schritt: 'neu_starten', grund: error.code } } });
        const neu = await stelleMainLaufSicher({ identity_id: session.identityId, runtime, modell: startModell, modell_explizit: modellExplizit });
        if (neu.zustand !== 'laeuft') throw new MainLaufFehler('main_start_dauert', { spawn_job_id: neu.spawn_job_id });
        r = await sendeMainTurn({ identity_id: session.identityId, runtime, nachricht: message, optionen, absender: 'user' });
      }
    } finally {
      vergissMainTurnSession(session.identityId, session.id);
    }
    if (r.art === 'zugestellt') {
      // P22-T73: mit Warteschlange ist das ein Einwurf; die Route reiht die Antwortzeile ein, die Antwort kommt ueber die Zustellung.
      const einwurf = await warteschlangeAktiv();
      emit({ event: 'runtime', data: { hauptagent: { weg: 'dauerhaft', schritt: 'zugestellt', hinweis: r.hinweis } } });
      if (!einwurf) emit({ event: 'delta', data: { content: r.hinweis } });
      else return { runtimeSessionId: session.runtimeSessionId, context: { ...(session.context ?? {}), hauptagent_weg: 'dauerhaft', einwurf: { inbox_id: r.inbox_id } } };
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
    // P22-T73: code bleibt am Fehler, damit die Route nicht zugestellte Nachrichten einreihen kann (NICHT_ERREICHT_CODES).
    throw Object.assign(new Error('Hauptagent im Container nicht erreichbar (' + code + ')' + (meldung ? ': ' + meldung : '')), { code, meldung });
  }
}
