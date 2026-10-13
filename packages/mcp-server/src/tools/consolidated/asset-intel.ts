/**
 * Synapse MCP - asset_intel Tool (P4-T70, Etappe B2)
 *
 * Haengt NUR ein: Schema und Dispatcher kommen aus core (services/asset-intel-tool.ts) — dieselben,
 * die die REST-Strecke (rest-api/src/routes/mcp.ts) benutzt. Hier steht bewusst KEINE eigene
 * Schema-Kopie: die beiden code_intel-Spiegel sind genau so auseinandergelaufen
 * (Entwurf thought 999610b9, Abschnitt 4.4).
 *
 * Unbekannte Parameter prueft schon der Server (PA-1, server.ts) gegen diese Definition, bevor der
 * Handler laeuft. fuehreAssetIntelAus wirft nie; Fehler kommen als success:false mit fehler-Code.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ASSET_INTEL_DEFINITION, fuehreAssetIntelAus } from '@synapse/core';

import { ConsolidatedTool } from './types.js';
import {rufeAssetKonfliktApi} from './asset-konflikt-api.js';
import {rufeAssetApi} from './asset-api.js';

export const assetIntelTool: ConsolidatedTool = {
  // as const in core macht die Arrays readonly; das MCP-Tool-Schema erwartet veraenderbare Typen.
  definition: ASSET_INTEL_DEFINITION as unknown as Tool,
  handler: (args) => args.action==='konflikte'||args.action==='konflikt_loesen'?rufeAssetKonfliktApi(args):fuehreAssetIntelAus(args),
};
// M4 ergänzt den fertigen A11/Legacy-Handler, ohne dessen Aktionen zu ersetzen.
const assetMetadataHandler=assetIntelTool.handler;
assetIntelTool.handler=args=>['geloescht','wiederherstellen'].includes(String(args.action))?rufeAssetApi(args):assetMetadataHandler(args);
