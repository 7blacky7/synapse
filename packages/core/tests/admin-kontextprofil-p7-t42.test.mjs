import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const load = (...parts) => import(pathToFileURL(join(repo, ...parts)).href);
// P22-T13 Paket D: additive Profilverwaltungs-Aktionen/-Parameter (agent-profil-admin.ts) sind ebenfalls neu; die Golden-Hashes bleiben unveraendert.
const w1bAktionen = ['profil_schalter_status', 'profil_schalter_setzen', 'profil_uebersicht', 'schattenprofil_liste', 'schattenprofil_korrigieren', 'schattenprofil_bestaetigen', 'schattenprofil_ablehnen',
  'typ_liste', 'typ_anlegen', 'typ_aendern', 'typ_revision_lesen', 'profil_aendern', 'profil_historie', 'profil_rollback', 'persona_liste', 'persona_versionen', 'persona_anlegen', 'persona_neue_version',
  'persona_zuweisen', 'persona_entfernen', 'token_abrufen', 'web_ui_koordinator_token', 'task_bindung_lesen', 'task_bindung_festlegen', 'task_bindung_aendern', 'task_bindung_entblocken',
  // P22-T33 (T1, User-Praezedenz 227150da: admin-Aktionen sichtbar ok): additive W12-Aktionen; die Golden-Hashes der alten Schemas bleiben unveraendert.
  'agent_vorbereiten', 'token_loeschen'];
const w1bParameter = ['profil_funktion', 'ziel_identity_id', 'schattenprofil_id', 'zustand', 'erwartete_revision', 'ziel_revision', 'korrektur', 'profil_patch', 'typ_id', 'typ_schluessel', 'typ_inhalt',
  'typ_revision', 'profil_scope', 'persona_name', 'persona_inhalt', 'persona_vorlage_id', 'persona_version', 'user_auftrag', 'user_zustimmung', 'anlass', 'bindung_task_id', 'bindung_art', 'bindung_identity_ids',
  // P22-T33 (T1, 227150da): additive W12-Parameter (agent_vorbereiten).
  'agent_name', 'rolle', 'startart'];
const neu = new Set(['kontextprofil_liste', 'kontextprofil_setzen', 'kontextprofil_entfernen', ...w1bAktionen]);
const neueParameter = new Set(['ziel', 'kontext_budget', 'stufe', 'hinweise_aus', 'hinweise_nur', ...w1bParameter]);
const alteSchemaProjektion = (tool) => {
  const properties = Object.fromEntries(Object.entries(tool.inputSchema.properties)
    .filter(([key]) => !neueParameter.has(key))
    .map(([key, value]) => [key, key === 'action'
      ? { ...value, enum: value.enum.filter((action) => !neu.has(action)) }
      : value]));
  return {
    description: tool.description,
    inputSchema: {
      ...tool.inputSchema,
      properties,
    },
  };
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const { adminTool } = await load('packages', 'mcp-server', 'dist', 'tools', 'consolidated', 'admin.js');
const { MCP_TOOLS } = await load('packages', 'rest-api', 'dist', 'routes', 'mcp.js');
const { TOOL_GUIDES } = await load('packages', 'core', 'dist', 'guide', 'content.js');
const restAdmin = MCP_TOOLS.find((tool) => tool.name === 'admin');
assert.ok(restAdmin, 'REST admin tool exists');
assert.ok(TOOL_GUIDES.admin, 'admin guide exists');

const beobachtet = {
  stdio: hash(alteSchemaProjektion(adminTool.definition)),
  rest: hash(alteSchemaProjektion(restAdmin)),
  guide: hash({ ...TOOL_GUIDES.admin, actions: Object.fromEntries(
    Object.entries(TOOL_GUIDES.admin.actions).filter(([action]) => !neu.has(action)),
  ) }),
};
// P22-T11 (t107): der persoenliche token-Parameter ist auf beiden Transporten gewollt und live;
// der REST-Hash spiegelt deshalb den Stand seit P22-T11 wider.
const golden = {
  stdio: '6fc6f4a0072feb0e8effa2c4809a3a106ce9b15b0a959c015ade228c9cac968d',
  // P22-T33 (T1, 227150da): bewusst aktualisiert; einzige Abweichung gegenueber ff9286f6...: token.description nennt 'bei JEDEM Aufruf mitgeben' (Ausweis je Aufruf, W12); stdio und guide bleiben byte-stabil.
  rest: '49baf297cfe775b44cbe323170a3b3e6573af5e7ed47c4a50b0507a7a93774ab',
  guide: '5f9399e44a5e8ec223b676ad4274a3e0abffb3508ac4e47fa659e5932de19108',
};
assert.deepEqual(beobachtet, golden, 'Bestehende Admin-Schemas und Guide-Actions müssen byte-stabil bleiben');
const {
  KONTEXTPROFIL_ADMIN_ACTIONS,
  KONTEXTPROFIL_ADMIN_PARAMETER,
  fuehreKontextprofilAdminAus,
  mitUserHerkunft,
} = await load('packages', 'core', 'dist', 'index.js');
const actions = ['kontextprofil_liste', 'kontextprofil_setzen', 'kontextprofil_entfernen'];
assert.deepEqual(KONTEXTPROFIL_ADMIN_ACTIONS, actions);
for (const tool of [adminTool.definition, restAdmin]) {
  assert.deepEqual(actions.every((action) => tool.inputSchema.properties.action.enum.includes(action)), true);
  for (const [name, schema] of Object.entries(KONTEXTPROFIL_ADMIN_PARAMETER)) {
    assert.deepEqual(tool.inputSchema.properties[name], schema, name + ' muss aus der gemeinsamen Core-Definition kommen');
  }
}
const argumente = {
  ziel: 'luna-*',
  kontext_budget: 25000,
  stufe: 'kompakt',
  hinweise_aus: ['shell_activity'],
  hinweise_nur: ['open_plans'],
  grund: 'Test',
};
for (const action of actions) {
  const verweigert = fuehreKontextprofilAdminAus(action, { ...argumente, agent_id: 'luna-2' }, 'luna-2');
  assert.equal(verweigert.status, 'forbidden');
  assert.equal(verweigert.success, false);
  const userOhneNachweis = fuehreKontextprofilAdminAus(action, { ...argumente, agent_id: 'user' }, 'user');
  assert.equal(userOhneNachweis.status, 'forbidden');
  const erlaubt = fuehreKontextprofilAdminAus(action, { ...argumente, agent_id: 'koordinator' }, 'koordinator');
  assert.equal(erlaubt.status, 'coming_soon');
  assert.equal(erlaubt.success, false);
  assert.deepEqual(erlaubt.parameter, argumente);
  const stdio = await adminTool.handler({ action, ...argumente, agent_id: 'koordinator' });
  assert.deepEqual(stdio, erlaubt, 'stdio benutzt den gemeinsamen read-only Dispatcher');
}
const echterUser = await mitUserHerkunft('web-ui-chat', async () =>
  fuehreKontextprofilAdminAus('kontextprofil_setzen', { ...argumente, agent_id: 'user' }, 'user'));
assert.equal(echterUser.status, 'coming_soon', 'nur belegte User-Herkunft darf den Stub verwenden');
console.log('P7-T42 admin Bestands-Golden unverändert; Schema, Rollen und Stub geprüft');
process.exit(0);
