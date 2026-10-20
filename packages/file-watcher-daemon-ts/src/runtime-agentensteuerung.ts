/**
 * MODUL: runtime-agentensteuerung.ts (P22-T6, W2c; Vertrag thought 825fcb16)
 * ZWECK: Komponente 'agentensteuerung' des Startprofils runtime (startprofile/runtime.ts). Der Daemon im Runtime-Container
 *        steuert Agenten wie der PC-Daemon (User 61c58de2 Pkt 2, Konzept e7ed9291 Architektur B):
 *          - spezialisten: DERSELBE Spezialisten-Worker wie am PC (specialist-job-worker.ts, API-Weg). Die API gibt dem
 *                          Runtime-Daemon nur Jobs mit args.target_runtime = eigene Runtime und die Projekte der Runtime
 *                          (Pfad /projects/<name> mit .synapse/agents). spawn/wake/stop laufen ueber dieselben Tools.
 *          - lebenszeichen: POST /api/daemon/heartbeat (melden) – beim Runtime-Daemon nur agent_runtime_daemon_zugaenge
 *                          (P22-T5), damit die API weiss, dass der dauerhafte Main-Weg erreichbar ist.
 *          - auftraege:    Runtime-Auftraege (agent_runtime_auftraege): claim -> accepted -> Ausfuehrung mit denselben
 *                          Spezialisten-Tools -> completed (tatsaechlich) | rejected. Fence: claim_revision.
 *          - wiederanbindung: laufende Wrapper nach einem Daemon-Neustart wieder an den Socket binden – derselbe Weg wie
 *                          lokal beim MCP-Serverstart (heartbeatController.reconnectAll aus .synapse/status.json je
 *                          Projektordner; tote PIDs werden dort aufgeraeumt). Beim Start und im Takt, damit wake nach
 *                          einem Neustart nicht 'nicht verbunden' meldet.
 *        Ohne API-Zugang startet nichts davon (kein PG-Rueckfall; Daten nur ueber die API).
 *
 * AUFTRAEGE IN T6a: neustart (stop + spawn mit konfiguriertem Modell), modellwechsel (stop + spawn mit gewuenscht.modell),
 *   stop. Nur fuer die Main-Identitaet (Spawn-Rezept des Hauptagenten); andere Identitaeten -> rejected
 *   ziel_nicht_unterstuetzt bis W3 (Spezialisten im Container). versoehnen (accepted + Lease abgelaufen): stop und spawn
 *   sind im Ergebnis wiederholbar (stop eines gestoppten Wrappers ist ein No-op, spawn startet genau einen), daher wird
 *   der Auftrag zu Ende gefuehrt statt verworfen.
 */
import {
  HAUPTAGENT_PROJEKT, HAUPTAGENT_AGENT_ID, HAUPTAGENT_EXPERTISE, HAUPTAGENT_AUFGABE, runtimeProjektPfad, werkzeugErgebnis,
  type SpecialistJobRow,
} from '@synapse/core';
import { anfrage, DAEMON_HOST, DAEMON_API_ID, heartbeatApi, holeProjekteApi, schlafe } from './daemon-jobs-api.js';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface AgentensteuerungHandle {
  stop: () => Promise<void>;
  projekte: () => string[];
}

interface RuntimeAuftrag {
  auftrag_id: string;
  identity_id: string;
  project: string;
  agent_id: string;
  art: 'neustart' | 'modellwechsel' | 'stop';
  status: 'claimed' | 'accepted';
  gewuenscht: Record<string, unknown>;
  claim_revision: number;
  modell_konfiguriert: string | null;
  /** P22-T65: gespeicherte Effort-Stufe des konfigurierten Modells (fehlt bei aelterer API). */
  effort_konfiguriert?: string | null;
  versoehnen: boolean;
}

const PROJEKTE_TAKT_MS = 60_000;
const LEBENSZEICHEN_TAKT_MS = 30_000;
const AUFTRAEGE_TAKT_MS = 10_000;
const ANBINDUNG_TAKT_MS = 15_000;

/**
 * Wie lokal (mcp-server server.ts): Wrapper aus status.json wieder anbinden. Zwei Orte (agents/src/status.ts):
 * Legacy-Laeufe im Projektordner (.synapse/agents/status.json), Identitaets-Laeufe (Hauptagent) je Identitaet unter
 * ~/.synapse/agent-runs/<identity_id>/status.json - die liest reconnectAll nur im Laufkontext dieser Identitaet.
 */
export async function bindeWrapperAn(projekte: string[], laufWurzel = join(homedir(), '.synapse', 'agent-runs')): Promise<void> {
  const { heartbeatController, mitAgentLaufUmgebung } = await import('@synapse/agents');
  let ids: string[] = [];
  try { ids = (await readdir(laufWurzel)).filter(n => /^[a-f0-9-]{36}$/.test(n)); } catch { /* noch keine Laeufe */ }
  for (const id of ids) {
    try {
      const r = await mitAgentLaufUmgebung('', '', { SYNAPSE_AGENT_IDENTITY_ID: id },
        () => heartbeatController.reconnectAll(join(laufWurzel, id)));
      if (r.connected.length || r.cleaned.length) {
        console.error(`[agentensteuerung] Lauf ${id}: angebunden [${r.connected.join(', ')}], aufgeraeumt [${r.cleaned.join(', ')}]`);
      }
    } catch (err) {
      console.error(`[agentensteuerung] Lauf ${id}: Wiederanbindung fehlgeschlagen:`, (err as Error).message);
    }
  }
  for (const p of projekte) {
    try {
      const r = await heartbeatController.reconnectAll(runtimeProjektPfad(p));
      if (r.connected.length || r.cleaned.length) {
        console.error(`[agentensteuerung] ${p}: angebunden [${r.connected.join(', ')}], aufgeraeumt [${r.cleaned.join(', ')}]`);
      }
    } catch (err) {
      console.error(`[agentensteuerung] ${p}: Wiederanbindung fehlgeschlagen:`, (err as Error).message);
    }
  }
}

async function melde(a: RuntimeAuftrag, schritt: 'accepted' | 'completed' | 'rejected', extra: Record<string, unknown> = {}): Promise<void> {
  await anfrage('/api/daemon/runtime-auftraege', {
    method: 'POST',
    body: { host: DAEMON_HOST, daemon_id: DAEMON_API_ID, aktion: 'melden', auftrag_id: a.auftrag_id, claim_revision: a.claim_revision, schritt, ...extra },
  }, 30_000);
}

/** Auftrag als Spezialisten-Job-Form fuer dispatchSpecialistAction (Datenweg-Bindung = auftrag_id + identity_id). */
function alsJob(a: RuntimeAuftrag, action: 'stop' | 'spawn', args: Record<string, unknown>): SpecialistJobRow {
  const jetzt = new Date();
  return {
    id: a.auftrag_id, project: a.project, action, args: { name: a.agent_id, identity_id: a.identity_id, ...args },
    status: 'running', result: null, error: null, message: null, claimed_by: DAEMON_API_ID, claimed_at: jetzt,
    completed_at: null, created_at: jetzt, updated_at: jetzt, actor_identity_id: null, target_identity_id: a.identity_id,
  };
}

function erfolg(result: Record<string, unknown>): { ok: boolean; meldung: string | null } {
  const e = werkzeugErgebnis(result) ?? {};
  return { ok: e.success !== false, meldung: typeof e.message === 'string' ? e.message.slice(0, 400) : null };
}

/** Fuehrt einen geclaimten Auftrag aus. Rueckgabe nur fuer Logs; Fehler werden als rejected gemeldet. */
export async function fuehreRuntimeAuftragAus(a: RuntimeAuftrag, runtime: string): Promise<'completed' | 'rejected'> {
  const { dispatchSpecialistAction } = await import('./specialist-job-worker.js');
  if (a.project !== HAUPTAGENT_PROJEKT || a.agent_id !== HAUPTAGENT_AGENT_ID) {
    await melde(a, 'rejected', { fehler: 'ziel_nicht_unterstuetzt: Runtime-Auftraege im Container in T6a nur fuer den Hauptagenten (W3 folgt)' });
    return 'rejected';
  }
  if (a.status === 'claimed') await melde(a, 'accepted');
  const pfad = runtimeProjektPfad(a.project);
  try {
    const stop = erfolg(await dispatchSpecialistAction(alsJob(a, 'stop', {}), { lokalerProjektpfad: pfad }));
    // Ein bereits gestoppter Wrapper ist fuer Neustart/Wechsel kein Fehler; fuer den Stop-Auftrag zaehlt nur das Ziel.
    if (a.art === 'stop') {
      if (!stop.ok && !/nicht (gefunden|verbunden|aktiv)|not running|kein/i.test(stop.meldung ?? '')) throw new Error(stop.meldung ?? 'stop fehlgeschlagen');
      await melde(a, 'completed', { tatsaechlich: { runtime } });
      return 'completed';
    }
    const modell = a.art === 'modellwechsel'
      ? (typeof a.gewuenscht.modell === 'string' ? a.gewuenscht.modell : null)
      : a.modell_konfiguriert;
    if (!modell) throw new Error('modell_fehlt: kein konfiguriertes bzw. gewuenschtes Modell');
    // P22-T65: modellwechsel mit gewuenschter Stufe; neustart behaelt die gespeicherte Stufe des konfigurierten Modells.
    const effort = typeof a.gewuenscht.effort === 'string' ? a.gewuenscht.effort
      : a.art === 'neustart' && typeof a.effort_konfiguriert === 'string' && a.effort_konfiguriert ? a.effort_konfiguriert : undefined;
    const spawn = erfolg(await dispatchSpecialistAction(alsJob(a, 'spawn', {
      model: modell, expertise: HAUPTAGENT_EXPERTISE, task: HAUPTAGENT_AUFGABE, project: a.project, project_path: pfad,
      keep_alive: true, target_runtime: runtime, ...(effort ? { effort } : {}),
    }), { lokalerProjektpfad: pfad }));
    if (!spawn.ok) throw new Error(spawn.meldung ?? 'spawn fehlgeschlagen');
    // tatsaechlich erst nach erfolgreichem Neustart (spawnSpecialistTool kehrt erst mit laufendem Wrapper zurueck).
    await melde(a, 'completed', { tatsaechlich: { modell, runtime } });
    return 'completed';
  } catch (err) {
    await melde(a, 'rejected', { fehler: ((err as Error).message ?? String(err)).slice(0, 400) }).catch((e: unknown) => {
      console.error(`[agentensteuerung] Ablehnung ${a.auftrag_id} nicht meldbar:`, (e as Error).message);
    });
    return 'rejected';
  }
}

/**
 * Startet die Agentensteuerung des Runtime-Daemons. runtime = Runtime dieses Containers (claude|codex), nur fuer
 * tatsaechlich/target_runtime; welche Jobs/Auftraege der Daemon bekommt, bindet die API an seinen Zugang.
 */
export async function starteRuntimeAgentensteuerung(o: { runtime: string }): Promise<AgentensteuerungHandle> {
  // Im Container gibt es keinen PG-Weg (DB gesperrt): Spezialisten-Worker ausdruecklich auf den API-Weg.
  process.env.SYNAPSE_DAEMON_JOBS_WEG = 'api';
  // Agenten im Container laufen nur mit Ausweis (Hauptagent P22-T36). Die intern-Bruecke, die am PC die agent_start-
  // Freigabe liefert, laeuft hier nicht; deshalb immer anfragen – die API prueft die Freigabe (ausweisTokenAktiv) selbst.
  if (process.env.SYNAPSE_TOKEN_IDENTITAET === undefined) process.env.SYNAPSE_TOKEN_IDENTITAET = '1';
  // P22-T6 (User): Nachrichten stellt im Container der Daemon zu (Job 'zustellen'), nicht der Wrapper-Takt und kein Hook.
  // Die Wrapper erben beide Variablen beim Spawn.
  process.env.SYNAPSE_ZUSTELLUNG_DAEMON = '1';
  process.env.SYNAPSE_KEINE_HOOKS = '1';
  let projekte: string[] = [HAUPTAGENT_PROJEKT];
  let gestoppt = false;
  const ladeProjekte = async () => {
    // synapse-hauptagent immer mit anfragen: nach einem Runtime-Wechsel (P22-T6c) bekommt diese Runtime den Main sofort,
    // nicht erst mit dem naechsten Projekt-Takt (pending Jobs verfallen nach 30 s). Der Server filtert ohnehin.
    try { projekte = [...new Set([HAUPTAGENT_PROJEKT, ...(await holeProjekteApi()).filter(p => p.enabled).map(p => p.name)])]; }
    catch (err) { console.error('[agentensteuerung] Projekte der Runtime nicht lesbar:', (err as Error).message); }
  };
  await ladeProjekte();

  // Erst wieder anbinden, dann Jobs annehmen: ein wake direkt nach dem Neustart trifft sonst einen 'nicht verbundenen' Wrapper.
  await bindeWrapperAn(projekte);
  const anbindungTimer = setInterval(() => { void bindeWrapperAn(projekte); }, ANBINDUNG_TAKT_MS);
  anbindungTimer.unref();

  const { startSpecialistJobWorker } = await import('./specialist-job-worker.js');
  const worker = await startSpecialistJobWorker(() => projekte);

  const lebenszeichen = async () => {
    try { await heartbeatApi('melden', projekte.length ? projekte : [HAUPTAGENT_PROJEKT]); }
    catch (err) { console.error('[agentensteuerung] Lebenszeichen fehlgeschlagen:', (err as Error).message); }
  };
  await lebenszeichen();
  const projektTimer = setInterval(() => { void ladeProjekte(); }, PROJEKTE_TAKT_MS);
  const lebenTimer = setInterval(() => { void lebenszeichen(); }, LEBENSZEICHEN_TAKT_MS);
  projektTimer.unref(); lebenTimer.unref();

  void (async () => {
    while (!gestoppt) {
      try {
        const a = await anfrage<{ auftraege?: RuntimeAuftrag[] }>('/api/daemon/runtime-auftraege',
          { method: 'POST', body: { host: DAEMON_HOST, daemon_id: DAEMON_API_ID, aktion: 'claim' } }, 30_000);
        // Nacheinander: zwei Auftraege derselben Identitaet duerfen sich nicht ueberholen.
        for (const auftrag of a.auftraege ?? []) {
          const r = await fuehreRuntimeAuftragAus(auftrag, o.runtime);
          console.error(`[agentensteuerung] Auftrag ${auftrag.auftrag_id} (${auftrag.art}) ${r}`);
        }
      } catch (err) {
        console.error('[agentensteuerung] Runtime-Auftraege nicht abrufbar:', (err as Error).message);
      }
      await schlafe(AUFTRAEGE_TAKT_MS);
    }
  })();

  return {
    projekte: () => [...projekte],
    stop: async () => {
      gestoppt = true;
      clearInterval(projektTimer);
      clearInterval(lebenTimer);
      clearInterval(anbindungTimer);
      await worker.stop();
    },
  };
}
