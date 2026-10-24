/**
 * P22-T125 R1 (stdio): specialist status ruft die Runtime-Uebersicht auch bei leerem Projekt auf (wie REST-MCP), damit die
 * nachgeladene eigene Zeile ('du selbst') erscheint. Quelltext-Vertrag (der Pfad braucht sonst DB + Ausweis-Kontext).
 *   node --test packages/mcp-server/tests/specialist-status-uebersicht-p22-t125.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const stdio = readFileSync(join(repo, 'packages/mcp-server/src/tools/consolidated/specialist.ts'), 'utf8');
const rest = readFileSync(join(repo, 'packages/rest-api/src/routes/mcp.ts'), 'utf8');

test('stdio: Leer-Zweig liefert runtime_uebersicht', () => {
  // Anker eindeutig: die Variable des Leer-Zweigs (nicht der mehrfach vorkommende Kommentar 'PG leer').
  const def = stdio.match(/const leerUebersicht = await leseRuntimeUebersicht\(project, rows\)/g) ?? [];
  assert.equal(def.length, 1, 'genau eine Definition im Leer-Zweig');
  assert.match(stdio, /runningCount: 0, lastUpdate: new Date\(\)\.toISOString\(\), \.\.\.leerUebersicht \}/);
  assert.match(stdio, /specialistStatusTool\(projectPath, undefined\) as Record<string, unknown>\), \.\.\.leerUebersicht/);
});

test('REST: Uebersicht nicht mehr an rows.length gebunden', () => {
  assert.ok(!/rows\.length \? await leseRuntimeUebersicht/.test(rest));
});
