/**
 * P22-T154: Artefakt-Quellen, deren Lesevertrag in der API liegt (nicht in core). Der Import meldet sie im core-Katalog an
 * (registriereArtefaktQuelle); artefakt-tool.ts, die Artefakt-Routen und artefakt-live.ts importieren dieses Modul.
 * agentennetzwerk.snapshot = derselbe Snapshot wie GET /api/projects/:name/agentennetzwerk (begrenzt, metadaten-only).
 */
import { registriereArtefaktQuelle } from '@synapse/core';
import { ladeAgentennetzwerk } from './agentennetzwerk.js';

registriereArtefaktQuelle({
  vertrag: 'agentennetzwerk.snapshot',
  beschreibung: 'Agentennetzwerk des Projekts (wie GET /api/projects/:name/agentennetzwerk): agenten, ereignisse, channel_ereignisse, werte',
  args: {},
  kanaele: ['synapse_tool_activity', 'synapse_event', 'synapse_channel'],
  lade: async ({ project }) => ladeAgentennetzwerk(project),
});

export const ARTEFAKT_QUELLEN_API = ['agentennetzwerk.snapshot'] as const;
