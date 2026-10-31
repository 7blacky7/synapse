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
assert.match(workspace,/showDashboard=\{area === 'main-agent' && !arbeitsbereich\.aktiv\}/,'P22-T253 SynapseWorkspace Netzwerk öffnet keinen Chat');
assert.match(main,/chatMode === 'auto' && !nurKnopf/,'P22-T253 MainAgentView Nachricht öffnet den Chat nicht nebenbei');
assert.match(workspace,/data-arbeitsbereich-quelle/,'P22-T253 Schalterquelle diagnostizierbar');
console.log('P22-T253 Navigation und Hauptagent OK');
