/**
 * MODUL: spezialisten-datenweg-api.ts (P9-T27, Welle 2)
 * ZWECK: API-Umsetzung von SpezialistenDatenweg (@synapse/mcp-server/tools). Der Daemon fuehrt die
 *        Spezialisten-Tools (spawn/stop/purge/wake) lokal aus; deren PG-Schritte (Channels,
 *        Chat-Sitzung, wrapper_status, Inbox, Modell-Registry) gehen hier ueber
 *        POST /api/daemon/specialist/daten statt ueber eine eigene DB-Verbindung.
 *
 * INSTALLATION: installiereSpezialistenApiWeg() — einmal beim Start des Spezialisten-Workers im
 *   API-Weg (daemon_jobs_weg=api). Danach nutzen auch direkte Tool-Aufrufe im Daemon diesen Weg.
 *
 * WRAPPER: neu gestartete Wrapper bekommen SYNAPSE_WRAPPER_TRANSPORT=api, SYNAPSE_API_URL und
 *   SYNAPSE_API_TOKEN (Tray-Zugang aus config.json), aber nur, wo die Umgebung sie nicht schon setzt.
 *   Damit braucht auch der Wrapper kein DATABASE_URL (agents/transport/api.ts).
 */

import type { ModellRegistryZeilen } from '@synapse/agents';
import type { SpezialistenDatenweg, WrapperStatusZeile } from '@synapse/mcp-server/tools';
import { agentLaufIdentitaet } from '@synapse/agents';
import { stoppeLokalenWrapper, type WrapperStopZugriff } from '@synapse/core';
import { spezialistenDatenApi } from './daemon-jobs-api.js';
import { leseApiZugang } from './skills-proxy.js';

/** Projekt ist im API-Weg Pflicht (Host-Pruefung der API); ohne Projekt klarer Fehler statt Raten. */
function mitProjekt(project: string | undefined, schritt: string): string {
  if (!project) throw new Error(`${schritt}: im Daemon-API-Weg ist das Projekt Pflicht`);
  return project;
}

const stopZugriff: WrapperStopZugriff = {
  identityId: (name) => agentLaufIdentitaet(name),
  projektpfad: async (project) => (await spezialistenDatenApi<{ pfad?: string | null }>('projektpfad', { project })).pfad ?? null,
  wrapperPid: async (name, project) => {
    const pid = (await spezialistenDatenApi<{ pid?: number | null }>('wrapper_pid', { project, agent: name })).pid;
    return typeof pid === 'number' && pid > 0 ? pid : null;
  },
  setzeGestoppt: async (name, project, pid) => { await spezialistenDatenApi('wrapper_gestoppt', { project, agent: name, pid }); },
};

export const apiSpezialistenDatenweg: SpezialistenDatenweg = {
  art: 'api',
  generalChannel: async (project, createdBy, agentName) => {
    await spezialistenDatenApi('general_channel', { project, created_by: createdBy, agent: agentName });
  },
  channelBeitreten: async (project, channel, agentName) =>
    (await spezialistenDatenApi<{ beigetreten?: boolean }>('channel_beitreten', { project, channel, agent: agentName })).beigetreten === true,
  sitzungNeu: async (name, project) => { await spezialistenDatenApi('sitzung_neu', { project, agent: name }); },
  wrapperStatus: async (zeile: WrapperStatusZeile) => { await spezialistenDatenApi('wrapper_status', { zeile }); },
  heartbeatBeimSpawn: async (project, name) => { await spezialistenDatenApi('heartbeat_beim_spawn', { project, agent: name }); },
  stoppeWrapper: (name, projectPath, project) => stoppeLokalenWrapper(name, projectPath, project, stopZugriff),
  ausAllenChannels: async (name, project) =>
    Number((await spezialistenDatenApi<{ anzahl?: number }>('aus_channels', { project: mitProjekt(project, 'aus_channels'), agent: name })).anzahl ?? 0),
  chatAbmelden: async (name, project) => {
    await spezialistenDatenApi('chat_abmelden', { project: mitProjekt(project, 'chat_abmelden'), agent: name });
  },
  wrapperStatusEntfernen: async (name, project) => { await spezialistenDatenApi('wrapper_status_entfernen', { project, agent: name }); },
  inboxEntfernen: async (name, project) =>
    Number((await spezialistenDatenApi<{ anzahl?: number }>('inbox_entfernen', { project: mitProjekt(project, 'inbox_entfernen'), agent: name })).anzahl ?? 0),
  inboxPost: async (fromAgent, toAgent, content, project) => {
    const a = await spezialistenDatenApi<{ id?: number }>('inbox_post', { project: mitProjekt(project, 'inbox_post'), from: fromAgent, to: toAgent, content });
    return { id: Number(a.id) };
  },
  wrapperUmgebung: () => {
    const { url, token } = leseApiZugang();
    const zusatz: Record<string, string> = {};
    if (!(process.env.SYNAPSE_WRAPPER_TRANSPORT ?? '').trim()) zusatz.SYNAPSE_WRAPPER_TRANSPORT = 'api';
    if (!(process.env.SYNAPSE_API_URL ?? '').trim() && url) zusatz.SYNAPSE_API_URL = url;
    if (!(process.env.SYNAPSE_API_TOKEN ?? '').trim() && token) zusatz.SYNAPSE_API_TOKEN = token;
    return zusatz;
  },
  // P22-T66: Bearer fuer die MCP-Config des Hauptagenten (Runtime-Daemon, gebundener Auftrag ueber daemonAuftragBindung).
  hauptagentMcp: async (name, project) => {
    const a = await spezialistenDatenApi<{ url?: string; bearer?: string }>('hauptagent_mcp', { project, agent: name });
    if (typeof a.url !== 'string' || typeof a.bearer !== 'string' || !a.bearer) throw new Error('hauptagent_mcp: Antwort ohne url/bearer');
    return { url: a.url, bearer: a.bearer };
  },
};

/** Modell-Registry ueber die API (statt core listModels aus PG). */
export async function holeModelleApi(): Promise<ModellRegistryZeilen> {
  const a = await spezialistenDatenApi<{ modelle?: ModellRegistryZeilen }>('modelle');
  if (!Array.isArray(a.modelle)) throw new Error('Modell-Registry der API ohne Liste');
  return a.modelle;
}

let installiert = false;

/** Setzt Datenweg und Modellquelle der Spezialisten-Tools auf die API (idempotent). */
export async function installiereSpezialistenApiWeg(): Promise<void> {
  if (installiert) return;
  const tools = await import('@synapse/mcp-server/tools');
  const agents = await import('@synapse/agents');
  tools.setzeSpezialistenDatenweg(apiSpezialistenDatenweg);
  agents.setzeModellQuelle(holeModelleApi);
  installiert = true;
  console.error('[specialist-worker] Spezialisten-Datenweg: API (keine PG-Verbindung fuer spawn/stop/purge/wake)');
}
