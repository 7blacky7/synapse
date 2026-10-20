/**
 * MODUL: spezialisten-datenweg.ts (P9-T27, Welle 2)
 * ZWECK: Die Spezialisten-Tools (spawn/stop/purge/wake) schreiben neben Dateien auch in PostgreSQL
 *        (Channels, Chat-Sitzung, wrapper_status, Inbox). Der lokale Daemon fuehrt diese Tools aus.
 *        Damit er dafuer KEIN DATABASE_URL braucht, laufen alle PG-Schritte ueber diese Schicht.
 *
 *   'pg'  (VORGABE) — genau die bisherigen Funktionen aus @synapse/core / @synapse/agents.
 *   'api'           — der Daemon setzt beim Start (daemon_jobs_weg=api) eine eigene Umsetzung, die
 *                     dieselben Schritte ueber die Synapse-API ausfuehrt (POST /api/daemon/specialist/daten).
 *
 * Prozess- und Dateiarbeit (Wrapper starten, Signale, /proc, status.json, Skills) bleibt lokal.
 */

import {
  beginneSitzung,
  upsertWrapperStatus,
  setzeHeartbeatBeimSpawn,
  removeWrapperStatus,
  removeInboxForAgent,
  stoppeLokalenWrapper,
  entferneAgentAusProjektChannels,
  meldeAgentImProjektAb,
  entferneInboxImProjekt,
} from '@synapse/core';
import {
  ensureGeneralChannel,
  joinChannel,
  removeAgentFromAllChannels,
  unregisterAgent,
  postToInbox,
} from '@synapse/agents';

/** Eingabe fuer wrapper_status (wie core upsertWrapperStatus). */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WrapperStopOptionen } from '@synapse/core';
import { agentLaufIdentitaet, agentLaufUmgebung } from '@synapse/agents';
export type WrapperStatusZeile = Parameters<typeof upsertWrapperStatus>[0];

export interface SpezialistenDatenweg {
  art: 'pg' | 'api';
  generalChannel(project: string, createdBy: string, agentName: string): Promise<void>;
  channelBeitreten(project: string, channel: string, agentName: string): Promise<boolean>;
  sitzungNeu(name: string, project: string): Promise<void>;
  wrapperStatus(zeile: WrapperStatusZeile): Promise<void>;
  heartbeatBeimSpawn(project: string, name: string): Promise<void>;
  stoppeWrapper(name: string, projectPath: string, project?: string, opt?: WrapperStopOptionen): Promise<Record<string, unknown>>;
  ausAllenChannels(name: string, project?: string): Promise<number>;
  chatAbmelden(name: string, project?: string): Promise<void>;
  wrapperStatusEntfernen(name: string, project: string): Promise<void>;
  inboxEntfernen(name: string, project?: string): Promise<number>;
  inboxPost(fromAgent: string, toAgent: string, content: string, project?: string): Promise<{ id: number }>;
  /** Zusatzvariablen fuer neu gestartete Wrapper (api: Transport + Zugang). pg: keine. */
  wrapperUmgebung(): Record<string, string>;
  /**
   * P22-T66: MCP-Zugang der inneren CLI des Hauptagenten im Runtime-Container (Bearer an die Main-Identitaet gebunden).
   * Nur der api-Weg des Runtime-Daemons; fehlt die Methode, gibt es diesen Zugang nicht.
   */
  hauptagentMcp?(name: string, project: string): Promise<{ url: string; bearer: string }>;
}

/** Bisheriges Verhalten, unveraendert. */
export const pgSpezialistenDatenweg: SpezialistenDatenweg = {
  art: 'pg',
  generalChannel: (project, createdBy, agentName) => ensureGeneralChannel(project, createdBy, agentName),
  channelBeitreten: (project, channel, agentName) => joinChannel(project, channel, agentName),
  sitzungNeu: async (name, project) => { await beginneSitzung(name, project, 'neu'); },
  wrapperStatus: (zeile) => upsertWrapperStatus(zeile),
  heartbeatBeimSpawn: (project, name) => setzeHeartbeatBeimSpawn(project, name),
  stoppeWrapper: (name, projectPath, project, opt) => stoppeLokalenWrapper(name, projectPath, project, undefined, opt),
  // P9-T27 Nachbesserung (291473c2 Nr. 1, Altbefund seit 354135ca): mit Projekt nur dieses Projekt;
  // ohne Projekt bleibt das bisherige globale Verhalten (Aufrufer ohne project-Angabe).
  ausAllenChannels: (name, project) => project ? entferneAgentAusProjektChannels(name, project) : removeAgentFromAllChannels(name),
  chatAbmelden: async (name, project) => { if (project) await meldeAgentImProjektAb(name, project); else await unregisterAgent(name); },
  wrapperStatusEntfernen: (name, project) => removeWrapperStatus(name, project),
  inboxEntfernen: async (name, project) => {
    if (!project) throw new Error('project ist fuer Inbox-Entfernung erforderlich');
    return (await entferneInboxImProjekt(name, project)).anzahl;
  },
  inboxPost: (fromAgent, toAgent, content, project) => project ? postToInbox(fromAgent, toAgent, content, project) : Promise.reject(new Error('project ist fuer Inbox-Post erforderlich')),
  wrapperUmgebung: () => ({}),
};

/** P22-T12: Start-Ausweis separat vom bisherigen PG/API-Datenweg beziehen. */
type AgentStartQuelle = (name: string, project: string) => Promise<Record<string, string>>;
let agentStartQuelle: AgentStartQuelle | null = null;
export function setzeAgentStartQuelle(quelle: AgentStartQuelle | null): void { agentStartQuelle = quelle; }
export async function holeAgentStartUmgebung(name: string, project: string): Promise<Record<string, string>> {
  if (agentLaufIdentitaet(name)) {
    const env = agentLaufUmgebung();
    if (env.SYNAPSE_AGENT_TOKEN) return Object.fromEntries(Object.entries(env).filter((e): e is [string,string] => typeof e[1] === 'string'));
  }
  return agentStartQuelle ? agentStartQuelle(name, project) : {};
}

const aufrufDatenweg = new AsyncLocalStorage<SpezialistenDatenweg>();
export function mitSpezialistenDatenweg<T>(weg:SpezialistenDatenweg, arbeit:()=>T):T { return aufrufDatenweg.run(weg,arbeit); }
let aktiv: SpezialistenDatenweg = pgSpezialistenDatenweg;

/** Setzt den Datenweg (null = zurueck auf PG). Der Daemon ruft das einmal beim Start. */
export function setzeSpezialistenDatenweg(weg: SpezialistenDatenweg | null): void {
  aktiv = weg ?? pgSpezialistenDatenweg;
}

export function spezialistenDatenweg(): SpezialistenDatenweg {
  return aufrufDatenweg.getStore() ?? aktiv;
}
