/** P22-T195: stdio nutzt denselben API-Vertrag; kein lokaler Schreib-Fallback. */
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {ANMERKUNGEN_DEFINITION} from '@synapse/core';
import type {ConsolidatedTool} from './types.js';
import {rufeArtefaktApi} from './artefakt.js';
export const anmerkungenTool:ConsolidatedTool={definition:ANMERKUNGEN_DEFINITION as unknown as Tool,handler:args=>rufeArtefaktApi(args,{werkzeug:'anmerkungen'})};
