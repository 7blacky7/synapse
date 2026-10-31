/** P22-T253: schaltbare Navigation und Hauptagent. Keine DB/Netz.
 * node --experimental-strip-types packages/web-ui/tests/arbeitsbereich-p22-t253.test.mjs
 * Herkunft: Task P22-T253, User-Vorgabe b92a5a84 / 362ea373.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const nav = await import('../src/mock/ui-control-plane.ts');
const H = 'P22-T253 ui-control-plane.ts';
assert.deepEqual(nav.navigationArbeitsbereich[0].items.map(i=>i.label), ['Übersicht'], H+' Übersicht vor Abschnitt');
assert.equal(nav.navigationArbeitsbereich[1].label, 'Arbeitsbereich', H+' Abschnitt');
const items=nav.navigationArbeitsbereich[1].items;
assert.equal(items[0].label,'Projektnetzwerk',H+' Projektnetzwerk ersetzt Hauptagent');
assert.equal(items.findIndex(i=>i.area==='channels'),items.findIndex(i=>i.area==='graph')+1,H+' Channels nach Graph');
const lies=(path)=>readFileSync(fileURLToPath(new URL(path,import.meta.url)),'utf8');
const workspace=lies('../src/components/workspace/SynapseWorkspace.tsx');
const main=lies('../src/views/hauptagent/MainAgentView.tsx');
// P22-T253, Befund 7e98696c: Dashboard muss auch bei neuer Navigation erscheinen; nurKnopf hält den Chat getrennt.
assert.match(workspace,/showDashboard=\{area === 'main-agent'\} nurKnopf=\{arbeitsbereich\.aktiv\}/,'P22-T253 SynapseWorkspace: Dashboard für Projektnetzwerk und separater Chat-Schalter');
assert.doesNotMatch(workspace,/<Agentennetzwerk\b/,'P22-T253 SynapseWorkspace: kein zweites Projektnetz neben dem Dashboard');
assert.match(main,/if \(!nurKnopf\) setChatCollapsed\(!showDashboard\)/,'P22-T253 MainAgentView: Dashboard öffnet Chat bei nurKnopf nicht');
const dashboard=lies('../src/components/MainAgentDashboard.tsx');
assert.match(dashboard,/<TopArtefakte project=\{project\}/,'P22-T253 MainAgentDashboard: Top-Artefakte des gewählten Projekts vorhanden');
assert.match(dashboard,/view === 'dreams'/,'P22-T253 MainAgentDashboard: Dreams weiterhin erreichbar');
assert.match(dashboard,/unterreiter === 'sitzung'/,'P22-T253 MainAgentDashboard: Sitzungsartefakte weiterhin erreichbar');
assert.match(main,/chatMode === 'auto' && !nurKnopf/,'P22-T253 MainAgentView Nachricht öffnet den Chat nicht nebenbei');
assert.match(workspace,/data-arbeitsbereich-quelle/,'P22-T253 Schalterquelle diagnostizierbar');
console.log('P22-T253 Navigation und Hauptagent OK');
