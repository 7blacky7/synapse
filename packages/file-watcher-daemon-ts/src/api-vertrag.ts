/**
 * P13-T19/A1: Typen des bestehenden Daemon/API-Transports.
 * Felder/Parser ausschließlich aus Core, kein zweiter Kanal/Ausweis.
 * Datei-Daemon und compute-node:<id>-Identität bleiben getrennt.
 */
export { API_CONTRACT_HEADER, API_CONTRACT_VERSION, parseApiContract } from '@synapse/core';
export type { ApiContract, ApiUploadSitzung, ApiObjektReferenz } from '@synapse/core';
import type { ApiContract } from '@synapse/core';
export interface ApiProjectsAntwort {
  success: boolean;
  projects: string[];
  activeWatchers: string[];
  localWatchers: string[];
  projectDetails: Array<{
    name: string;
    path: string | null;
    enabled: boolean;
    lastAccess: string | null;
  }>;
  capabilities?: ApiContract;
}
