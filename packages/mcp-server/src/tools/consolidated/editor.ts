/** P22-T256: Agentenvertrag läuft über die Synapse-API, ohne lokalen DB-Zugriff. */
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {EDITOR_PRUEFPLAN_DEFINITION} from '@synapse/core';
import type {ConsolidatedTool} from './types.js';
import {rufeArtefaktApi} from './artefakt.js';
export const editorPruefplanTool:ConsolidatedTool={definition:EDITOR_PRUEFPLAN_DEFINITION as unknown as Tool,handler:args=>rufeArtefaktApi(args,{werkzeug:'editor_pruefplan'})};
