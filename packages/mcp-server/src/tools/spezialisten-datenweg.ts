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
export type WrapperStatusZeile = Parameters<typeof upsertWrapperStatus>[0];

export interface SpezialistenDatenweg {
  art: 'pg' | 'api';
  generalChannel(project: string, createdBy: string, agentName: string): Promise<void>;
  channelBeitreten(project: string, channel: string, agentName: string): Promise<boolean>;
  sitzungNeu(name: string, project: string): Promise<void>;
  wrapperStatus(zeile: WrapperStatusZeile): Promise<void>;
  heartbeatBeimSpawn(project: string, name: string): Promise<void>;
  stoppeWrapper(name: string, projectPath: string, project?: string): Promise<Record<string, unknown>>;
  ausAllenChannels(name: string, project?: string): Promise<number>;
  chatAbmelden(name: string, project?: string): Promise<void>;
  wrapperStatusEntfernen(name: string, project: string): Promise<void>;
  inboxEntfernen(name: string, project?: string): Promise<number>;
  inboxPost(fromAgent: string, toAgent: string, content: string, project?: string): Promise<{ id: number }>;
  /** Zusatzvariablen fuer neu gestartete Wrapper (api: Transport + Zugang). pg: keine. */
  wrapperUmgebung(): Record<string, string>;
}

/** Bisheriges Verhalten, unveraendert. */
export const pgSpezialistenDatenweg: SpezialistenDatenweg = {
  art: 'pg',
  generalChannel: (project, createdBy, agentName) => ensureGeneralChannel(project, createdBy, agentName),
  channelBeitreten: (project, channel, agentName) => joinChannel(project, channel, agentName),
  sitzungNeu: async (name, project) => { await beginneSitzung(name, project, 'neu'); },
  wrapperStatus: (zeile) => upsertWrapperStatus(zeile),
  heartbeatBeimSpawn: (project, name) => setzeHeartbeatBeimSpawn(project, name),
  stoppeWrapper: (name, projectPath, project) => stoppeLokalenWrapper(name, projectPath, project),
  // P9-T27 Nachbesserung (291473c2 Nr. 1, Altbefund seit 354135ca): mit Projekt nur dieses Projekt;
  // ohne Projekt bleibt das bisherige globale Verhalten (Aufrufer ohne project-Angabe).
  ausAllenChannels: (name, project) => project ? entferneAgentAusProjektChannels(name, project) : removeAgentFromAllChannels(name),
  chatAbmelden: async (name, project) => { if (project) await meldeAgentImProjektAb(name, project); else await unregisterAgent(name); },
  wrapperStatusEntfernen: (name, project) => removeWrapperStatus(name, project),
  inboxEntfernen: async (name, project) => {
    if (!project) return removeInboxForAgent(name);
    const r = await entferneInboxImProjekt(name, project);
    if (r.andereProjekte.length > 0) {
      throw new Error(`Inbox nicht geloescht: Name "${name}" auch in Projekt(en) ${r.andereProjekte.join(', ')} (Inbox hat keine Projektspalte)`);
    }
    return r.anzahl;
  },
  inboxPost: (fromAgent, toAgent, content) => postToInbox(fromAgent, toAgent, content),
  wrapperUmgebung: () => ({}),
};

let aktiv: SpezialistenDatenweg = pgSpezialistenDatenweg;

/** Setzt den Datenweg (null = zurueck auf PG). Der Daemon ruft das einmal beim Start. */
export function setzeSpezialistenDatenweg(weg: SpezialistenDatenweg | null): void {
  aktiv = weg ?? pgSpezialistenDatenweg;
}

export function spezialistenDatenweg(): SpezialistenDatenweg {
  return aktiv;
}
