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
  getPool, HAUPTAGENT_PROJEKT, apiProviderFuerModell, leseApiLaufSchalter, legeApiLaufAn, legeApiEingangAn, leseApiLaufWahl,
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
/** P22-T278 P2-1: Wartezeit auf den Rueckfall-Modellwechsel des Main (wie der Start in stelleMainLaufSicher: 90 s). */
const RUECKFALL_WECHSEL_WARTE_MS = 90_000;

/** P22-T278 P2-1: Ausgabe von apiLaufMainTurn an den Aufrufer, wenn der Turn in den Rueckfall ging (null = kein Auftrag offen). */
export interface ApiMainTurnInfo { rueckfall?: { modell: string | null } }

/**
 * P22-T278 P2-1: Nach dem Rueckfall startet der Runtime-Daemon den Main ueber den Modellwechsel-Auftrag (stop + spawn). Der Chat-Turn
 * wartet darauf, statt parallel selbst zu starten (sonst zwei Starts derselben Identitaet bzw. ein Neustart mitten im Turn).
 * Nach der Wartezeit noch offen -> main_start_dauert (wie ein langsamer Start; die Nachricht wird nicht ausgefuehrt, nie doppelt).
 */
export async function warteAufRueckfallWechsel(identityId: string, warteMs = RUECKFALL_WECHSEL_WARTE_MS, taktMs = 1_000): Promise<{ gewartet_ms: number }> {
  const { RUECKFALL_AUFTRAG_VON } = await import('../api-agent-lauf.js');
  const start = Date.now();
  while (true) {
    const r = await getPool().query<{ id: string }>(
      "SELECT id FROM agent_runtime_auftraege WHERE identity_id = $1 AND erstellt_von = $2 AND status IN ('pending','claimed','accepted') LIMIT 1",
      [identityId, RUECKFALL_AUFTRAG_VON]);
    if (!r.rows[0]) return { gewartet_ms: Date.now() - start };
    if (Date.now() - start >= warteMs) throw new MainLaufFehler('main_start_dauert', { auftrag_id: r.rows[0].id, grund: 'rueckfall_modellwechsel_offen' });
    await new Promise(res => setTimeout(res, taktMs));
  }
}

export async function apiLaufMainTurn(
  session: MainAgentSession, message: string, modell: string, emit: (event: RuntimeStreamEvent) => void, info?: ApiMainTurnInfo,
): Promise<RuntimeMessageResult | null> {
  const identityId = session.identityId;
  if (!identityId) return null;
  const anbieter = await apiProviderFuerModell(modell).catch(() => null);
  const wahl = await leseApiLaufWahl(identityId);
  if (!anbieter || !(await leseApiLaufSchalter(HAUPTAGENT_PROJEKT)).aktiv) {
    if (wahl) throw Object.assign(new Error('api_lauf_aus'),{code:'api_lauf_aus'});
    return null;
  }
  if (wahl && (wahl.phase!=='aktiv' || wahl.modell!==modell)) throw Object.assign(new Error('api_wechsel_nicht_bereit'),{code:'api_wechsel_nicht_bereit'});
  const { apiAgentLauf, RUECKFALL_AUFTRAG_VON } = await import('../api-agent-lauf.js');
  const verwaltung = apiAgentLauf();
  if (!verwaltung) {
    throw Object.assign(new Error('Hauptagent per API-Lauf nicht moeglich (api_lauf_aus): Lauf-Verwaltung laeuft nicht (SYNAPSE_API_AGENTEN_LAUF_DISABLED)'),
      { code: 'api_lauf_aus', meldung: null });
  }
  // Rueckfall auf Container (Tageslimit erschoepft, User-Korrektur 26.10.): kein automatischer Rueckwechsel -> Bestand.
  const vorher = await getPool().query<{ status: string; letzter_fehler: string | null }>(
    'SELECT status, letzter_fehler FROM api_agent_laeufe WHERE identity_id = $1', [identityId]).catch(() => null);
  const z = vorher?.rows[0];
  if (wahl && (!z || ['gestoppt','pausiert','fehler'].includes(z.status)))
    throw Object.assign(new Error('api_lauf_nicht_bereit'),{code:'api_lauf_nicht_bereit'});
  if (z && z.status === 'gestoppt' && (z.letzter_fehler ?? '').startsWith('rueckfall_container:')) return null;
  const i = await getPool().query<{ agent_id: string }>('SELECT agent_id FROM agent_identitaeten WHERE id = $1', [identityId]);
  if (!wahl) await legeApiLaufAn({ identity_id: identityId, project: HAUPTAGENT_PROJEKT, agent_id: i.rows[0]?.agent_id ?? 'hauptagent', rolle: 'main', modell, anbieter,
    gestartet_von: 'user' });
  emit({ event: 'runtime', data: { hauptagent: { weg: 'api_lauf', identity_id: identityId, modell, anbieter, schritt: 'arbeitet' } } });
  const eingang = await legeApiEingangAn({ identity_id: identityId, text: message, quelle: 'main_chat', absender: 'user' });
  const r = await verwaltung.warteAufEingang(eingang.id, API_MAIN_WARTE_MS);
  if (r.art === 'nicht_begonnen' && r.code === 'rueckfall_container') {
    // Tageslimit gerade erschoepft: Rueckfall, diese Nachricht geht genau einmal ueber den Container-Main (Bestand) des Aufrufers.
    // P22-T278 P2-1 (Abnahme 1dbf6af2): auch MIT Laufwahl (T202-Weg der UI); rueckfallContainer hat Lease und Wahl freigegeben und den
    // main_chat-Eingang ohne API-Turn erledigt. Das Rueckfallmodell (offener Modellwechsel-Auftrag) geht an den Aufrufer.
    const w = await getPool().query<{ modell: string | null }>(
      "SELECT gewuenscht->>'modell' AS modell FROM agent_runtime_auftraege WHERE identity_id = $1 AND erstellt_von = $2 AND status IN ('pending','claimed','accepted') LIMIT 1",
      [identityId, RUECKFALL_AUFTRAG_VON]).catch(() => null);
    const rueckfallModell = w?.rows[0]?.modell ?? null;
    if (info) info.rueckfall = { modell: rueckfallModell };
    emit({ event: 'runtime', data: { hauptagent: { weg: 'ruckfall_container', identity_id: identityId, grund: 'budget_erschoepft', modell: rueckfallModell, mit_wahl: !!wahl } } });
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
  const info: ApiMainTurnInfo = {};
  const apiTurn = await apiLaufMainTurn(session, message, modell, emit, info);
  if (apiTurn) return apiTurn;
  const optionen = leseMainLaufOptionen();
  if (!(await runtimeDaemonAngemeldet(runtime))) {
    if (optionen.ohne_daemon === 'fehler') throw new Error('Runtime-Daemon im Container ist nicht angemeldet (runtime_daemon_fehlt)');
    emit({ event: 'runtime', data: { hauptagent: { weg: 'altweg', hinweis: 'runtime_daemon_fehlt' } } });
    return null;
  }
  try {
    emit({ event: 'runtime', data: { hauptagent: { weg: 'dauerhaft', identity_id: session.identityId, schritt: 'start_pruefen' } } });
    // P22-T278 P2-1: nach dem Rueckfall erst den Modellwechsel-Auftrag abwarten (er startet den Main mit dem Rueckfallmodell).
    // P22-T279 Punkt 2: IMMER abwarten, solange ein Rueckfall-Wechsel (erstellt_von RUECKFALL_AUFTRAG_VON) offen ist - auch wenn ein
    // Hintergrund-Turn des Main den Rueckfall ausgeloest hat und diese Chatnachricht nichts davon weiss (sonst Start parallel zum Daemon).
    if (info.rueckfall) emit({ event: 'runtime', data: { hauptagent: { weg: 'dauerhaft', schritt: 'rueckfall_wechsel_abwarten', modell: info.rueckfall.modell } } });
    const rueckfallWarten = await warteAufRueckfallWechsel(session.identityId);
    if (!info.rueckfall && rueckfallWarten.gewartet_ms > 0) {
      emit({ event: 'runtime', data: { hauptagent: { weg: 'dauerhaft', schritt: 'rueckfall_wechsel_abgewartet', gewartet_ms: rueckfallWarten.gewartet_ms } } });
    }
    // P22-T62: Start noetig -> Standard aus core (Schalter hauptagent_cli_modelle EIN: User-Wahl der Runtime bzw. kleinstes
    // Modell der CLI-Liste; AUS: das uebergebene Treiber-Modell). Ein konfiguriertes Profil-Modell geht in stelleMainLaufSicher vor.
    // P22-T70: die User-Wahl ist ausdruecklich und geht vor dem Profil-Modell (modell_bestaetigt) in stelleMainLaufSicher.
    let startModell = modell;
    let modellExplizit = false;
    if ((await leseMainLauf(session.identityId, runtime)).zustand !== 'laeuft') {
      if (info.rueckfall?.modell) {
        // P22-T278 P2-1: Main laeuft nach dem Wechsel-Auftrag noch nicht -> mit dem Rueckfallmodell starten, nie mit dem API-Alias.
        startModell = info.rueckfall.modell;
        modellExplizit = true;
      } else if (info.rueckfall) {
        // P22-T279 Punkt 3: Rueckfall ohne verfuegbares Kettenmodell -> klarer Fehler statt Start mit dem API-Modell als Vorgabe.
        throw new MainLaufFehler('rueckfall_ohne_modell', { runtime, grund: 'Tageslimit erreicht, aber kein Modell der Rueckfall-Kette ist verfuegbar (Einstellungen > API-Agenten > Rueckfall bei Tageslimit).' });
      } else {
        // P22-T279 Punkt 3: ein API-Alias ist nie Vorgabe fuer den CLI-Start (Schalter hauptagent_cli_modelle AUS = Altstandard).
        const apiAlias = !!(await apiProviderFuerModell(modell).catch(() => null));
        const w = await standardModellFuerRuntime(runtime, async () => {
          if (apiAlias) throw new MainLaufFehler('rueckfall_ohne_modell', { runtime, modell, grund: 'API-Modell ist keine Vorgabe fuer den CLI-Start; CLI-Modell im Modell-Chip waehlen.' });
          return modell;
        });
        if (!w.modell) throw new MainLaufFehler('standardmodell_unbestimmt', { runtime, grund: w.grund });
        startModell = w.modell;
        modellExplizit = w.quelle === 'user_wahl';
      }
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
