// Artefakt-Tool: Bausteine gegen den GEBAUTEN dist (Haus-Muster: plain node,
// node:test, exit != 0 bei rot). Die PG-/Docker-/ki-browser-Wege prueft der
// erste echte Lauf — hier stehen die puren Bausteine, die ohne Infrastruktur
// beweisbar sind: MCP-Config, Kommando-Flags, Stream-Registry, Eingabe-Pruefung.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeCommand,
  buildHauptagentMcpConfig,
} from '../dist/services/agent-runtime/claude-driver.js';
import {
  registerArtifactStream,
  unregisterArtifactStream,
  emitArtifact,
  countArtifacts,
} from '../dist/services/agent-runtime/artifact-stream.js';
import { pruefeArtefaktEingabe, ARTEFAKT_HTML_MAX } from '../../core/dist/services/artefakt.js';

test('Hauptagenten-MCP-Config: GENAU EIN Server, Session im Header', () => {
  const roh = buildHauptagentMcpConfig('http://synapse-api:3456/', 'tok-123', 'sess-1');
  const config = JSON.parse(roh);
  assert.deepEqual(Object.keys(config), ['mcpServers']);
  assert.deepEqual(Object.keys(config.mcpServers), ['synapse']);
  assert.equal(config.mcpServers.synapse.type, 'http');
  assert.equal(config.mcpServers.synapse.url, 'http://synapse-api:3456/');
  assert.equal(config.mcpServers.synapse.headers.Authorization, 'Bearer tok-123');
  assert.equal(config.mcpServers.synapse.headers['X-Synapse-Hauptagent-Session'], 'sess-1');
});

test('buildClaudeCommand: ohne Config wie bisher, mit Config genau ein freigeschaltetes Tool', () => {
  const ohne = buildClaudeCommand(null, 'sonnet');
  assert.equal(ohne[ohne.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(ohne.includes('--allowedTools'), false);

  const config = buildHauptagentMcpConfig('http://synapse-api:3456/', 'tok', 'sess');
  const mit = buildClaudeCommand(null, 'sonnet', config);
  assert.equal(mit[mit.indexOf('--mcp-config') + 1], config);
  assert.equal(mit.filter((teil) => teil === '--allowedTools').length, 1);
  assert.equal(mit[mit.indexOf('--allowedTools') + 1], 'mcp__synapse__artefakt');

  // --resume bleibt auch mit Config das letzte Flag (Resume-Semantik unveraendert)
  const resumed = buildClaudeCommand('session-1', 'sonnet', config);
  assert.deepEqual(resumed.slice(-2), ['--resume', 'session-1']);
});

test('Artefakt-Stream-Registry: Zustellung nur in registrierte Sessions, Zaehlung stimmt', () => {
  const empfangen = [];
  assert.equal(emitArtifact('s-1', { id: 'a' }), false, 'vor register darf nichts zugestellt werden');

  registerArtifactStream('s-1', (event) => empfangen.push(event));
  assert.equal(emitArtifact('s-1', { id: 'a', html: '<p>1</p>' }), true);
  assert.equal(emitArtifact('s-1', { id: 'b', html: '<p>2</p>' }), true);
  assert.equal(countArtifacts('s-1'), 2);
  assert.equal(empfangen.length, 2);
  assert.equal(empfangen[0].event, 'artifact');
  assert.equal(empfangen[0].data.id, 'a');

  // Fremde Session bleibt unberuehrt — kein Broadcast
  assert.equal(emitArtifact('s-2', { id: 'c' }), false);
  assert.equal(countArtifacts('s-2'), 0);

  unregisterArtifactStream('s-1');
  assert.equal(emitArtifact('s-1', { id: 'd' }), false, 'nach unregister keine Zustellung mehr');
  assert.equal(countArtifacts('s-1'), 0);
});

test('pruefeArtefaktEingabe: gueltig -> null, jede Verletzung benennt sich selbst', () => {
  assert.equal(pruefeArtefaktEingabe({ sessionId: 's', html: '<p>ok</p>' }), null);
  assert.match(pruefeArtefaktEingabe({ sessionId: '', html: '<p>x</p>' }), /session_id/);
  assert.match(pruefeArtefaktEingabe({ sessionId: 's', html: '   ' }), /html ist Pflicht/);
  assert.match(pruefeArtefaktEingabe({ sessionId: 's', html: 'x'.repeat(ARTEFAKT_HTML_MAX + 1) }), /zu gross/);
  assert.match(pruefeArtefaktEingabe({ sessionId: 's', html: '<p>x</p>', column: 1.5 }), /Ganzzahl/);
  assert.match(pruefeArtefaktEingabe({ sessionId: 's', html: '<p>x</p>', minHeight: -1 }), /Ganzzahl/);
});
