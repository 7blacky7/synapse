/**
 * P22-T80: agenten_aufraeumen ist im Tool-Schema (tools/list) von mcp-server UND REST sichtbar: Aktion im admin-Enum, Parameter vorhanden.
 *   node --test packages/rest-api/tests/agent-entfernung-tools-p22-t80.test.mjs   (nach pnpm build in core, mcp-server, rest-api)
 * Keine DB, kein Netz: nur die Tool-Definitionen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Der Import der REST-Routen laesst Handles (Pools, Timer) offen: nach den Tests sauber beenden statt haengen.
test.after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 300); });

const PARAMETER = ['aufraeumen_modus', 'aufraeumen_tage', 'aufraeumen_art', 'aufraeumen_ids', 'aufraeumen_bestaetigung', 'aufraeumen_lauf_id', 'aufraeumen_alle', 'mit_entfernten'];

function pruefe(tool, wo) {
  const props = tool.inputSchema?.properties ?? {};
  assert.ok(Array.isArray(props.action?.enum), wo + ': admin hat ein action-Enum');
  assert.ok(props.action.enum.includes('agenten_aufraeumen'), wo + ': action agenten_aufraeumen im Enum');
  for (const p of PARAMETER) assert.ok(props[p], wo + ': Parameter ' + p);
  assert.deepEqual(props.aufraeumen_modus.enum, ['vorschau', 'ausfuehren', 'wiederherstellen', 'status', 'einstellen'], wo + ': Modi');
}

test('mcp-server: admin-Tool kennt agenten_aufraeumen', async () => {
  const { adminTool } = await import('../../mcp-server/dist/tools/consolidated/admin.js');
  pruefe(adminTool.definition, 'mcp-server');
});

test('REST: MCP_TOOLS (Quelle beider tools/list-Wege) kennt agenten_aufraeumen', async () => {
  const { MCP_TOOLS } = await import('../dist/routes/mcp.js');
  const admin = MCP_TOOLS.find((t) => t.name === 'admin');
  assert.ok(admin, 'REST: Tool admin vorhanden');
  pruefe(admin, 'REST');
});
