#!/usr/bin/env node
// test-status-pid-tokens.mjs — P7-T32
//   Teil 1: alte innere PID nach Neustart. Der Upsert setzt inner_pid bei innerPidZuruecksetzen:true
//           ausdruecklich auf NULL (nie 0: process.kill(0, ..) trifft die ganze Prozessgruppe);
//           ohne das Flag bleibt COALESCE. Der Wrapper schickt es beim initialen Write und schreibt nach
//           jedem Prozessstart sofort die echte PID.
//   Teil 2: tokens 0 im laufenden Turn. Der 90-s-Timer liest bei agentBusy vorher die Tokens (JSONL).
//   Teil 3: Zuordnung der HTTP-Bruecke. Header X-Synapse-Agent -> agent_id (nur gueltige Namen, kein Fehler
//           bei ungueltigen, OpenAI-Ableitung bleibt); mcp-http.json traegt den Header.
// Aufruf (nach pnpm build): node scripts/test-status-pid-tokens.mjs   (Exit 1 bei Fehler; keine DB noetig)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

// ===== Teil 1: SQL =====
let ws = {};
await pruefe('wrapper-status exportiert baueWrapperStatusUpsert', async () => {
  ws = await import('../packages/core/dist/services/wrapper-status.js');
  assert.equal(typeof ws.baueWrapperStatusUpsert, 'function');
});
const baue = ws.baueWrapperStatusUpsert;

await pruefe('T1a: innerPidZuruecksetzen:true -> Parameter true, SQL setzt inner_pid auf NULL', () => {
  const { text, values } = baue({ agentName: 'a', project: 'p', innerPid: null, innerPidZuruecksetzen: true });
  assert.match(text, /inner_pid\s*=\s*CASE WHEN \$19::BOOLEAN THEN \$4 ELSE COALESCE\(\$4,\s*wrapper_status\.inner_pid\) END/);
  assert.equal(values[18], true);
  assert.equal(values[3], null);
});
await pruefe('T1b: ohne Flag -> false, PID bleibt per COALESCE erhalten; nie 0 als Ersatz', () => {
  const { values } = baue({ agentName: 'a', project: 'p', innerPid: 4711 });
  assert.equal(values[18], false);
  assert.equal(values[3], 4711);
  const leer = baue({ agentName: 'a', project: 'p' });
  assert.equal(leer.values[3], null);
});
await pruefe('T1c: Reset mit echter PID (Wrapper hat schon gestartet) schreibt die PID', () => {
  const { values } = baue({ agentName: 'a', project: 'p', innerPid: 99, innerPidZuruecksetzen: true });
  assert.equal(values[3], 99);
  assert.equal(values[18], true);
});

// ===== Wrapper-Verdrahtung (Quelltext) =====
const wrapper = await readFile(new URL('../packages/agents/src/wrapper.ts', import.meta.url), 'utf8');
const typen = await readFile(new URL('../packages/agents/src/transport/typen.ts', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../packages/rest-api/src/routes/wrapper-bridge.ts', import.meta.url), 'utf8');

await pruefe('T1d: initialer PG-Write setzt innerPidZuruecksetzen:true und nimmt die echte PID', () => {
  const stelle = wrapper.indexOf('Initiale PG-Zeile schreiben');
  assert.ok(stelle > 0, 'Abschnitt fehlt');
  const block = wrapper.slice(stelle, stelle + 1800);
  assert.match(block, /innerPidZuruecksetzen:\s*true/);
  assert.match(block, /innerPid:\s*processManager\.getStatus\(\)\.get\(AGENT_NAME\)\?\.pid\s*\?\?\s*null/);
});
await pruefe('T1e: nach processManager.start schreibt der Wrapper sofort die echte PID (erzwungen, sobald PG-Status steht)', () => {
  const m = wrapper.match(/async function startAgentProcess[\s\S]*?\n\}\n/);
  assert.ok(m, 'startAgentProcess fehlt');
  assert.match(m[0], /pgStatusInitialisiert/);
  assert.match(m[0], /updateStatusPg\('running'\)/);
});
await pruefe('T1f: StatusNutzlast + Bridge (/status und /register) kennen innerPidZuruecksetzen', () => {
  assert.match(typen, /innerPidZuruecksetzen\?:\s*boolean/);
  const treffer = bridge.match(/innerPidZuruecksetzen:\s*alsBool\(/g) ?? [];
  assert.equal(treffer.length, 2, `erwartet 2 (status+register), gefunden ${treffer.length}`);
});

// ===== Teil 2 =====
await pruefe('T2: 90-s-Timer synchronisiert die Tokens bei agentBusy, non-fatal', () => {
  const m = wrapper.match(/pgWriteTimerId = setInterval\([\s\S]*?\}, WRAPPER_STATUS_PG_WRITE_INTERVAL_MS\)/);
  assert.ok(m, 'Timer fehlt');
  assert.match(m[0], /agentBusy/);
  assert.match(m[0], /syncTokensFromHistory\(\)/);
  assert.match(m[0], /catch/);
});

// ===== Teil 3 =====
let hdr = {};
await pruefe('rest-api exportiert leiteAgentIdAusHeaders', async () => {
  hdr = await import('../packages/rest-api/dist/routes/agent-header.js');
  assert.equal(typeof hdr.leiteAgentIdAusHeaders, 'function');
});
const leite = hdr.leiteAgentIdAusHeaders;
await pruefe('T3a: X-Synapse-Agent gueltig -> Name', () => {
  assert.equal(leite({ 'x-synapse-agent': 'plan-specht' }), 'plan-specht');
});
await pruefe('T3b: ungueltige Namen werden ignoriert (kein Fehler)', () => {
  for (const schlecht of ['', 'a b', "x'; DROP", 'a'.repeat(65), '../etc', ['x'], 5, null, undefined]) {
    assert.equal(leite({ 'x-synapse-agent': schlecht }), undefined, String(schlecht));
  }
});
await pruefe('T3c: OpenAI-Ableitung bleibt, Header hat Vorrang nur wenn kein OpenAI-Agent', () => {
  assert.equal(leite({ 'user-agent': 'openai-mcp/1.0', 'x-openai-session': 'v1/abcdefgh1234' }), 'gpt-abcdefgh');
  assert.equal(leite({ 'user-agent': 'node' }), undefined);
});

let br = {};
await pruefe('mcp-bruecke exportiert baueBrueckenConfig', async () => {
  br = await import('../packages/mcp-server/dist/tools/mcp-bruecke.js');
  assert.equal(typeof br.baueBrueckenConfig, 'function');
});
await pruefe('T3d: mcp-http.json traegt Authorization UND X-Synapse-Agent', () => {
  const c = br.baueBrueckenConfig('http://x/mcp', 'tok', 'plan-specht');
  const s = Object.values(c.mcpServers)[0];
  assert.equal(s.type, 'http');
  assert.equal(s.url, 'http://x/mcp');
  assert.equal(s.headers.Authorization, 'Bearer tok');
  assert.equal(s.headers['X-Synapse-Agent'], 'plan-specht');
});
await pruefe('T3e: REST nutzt die gemeinsame Funktion an beiden Stellen (kein lokales deriveAgentIdFromHeaders mehr)', async () => {
  const mcp = await readFile(new URL('../packages/rest-api/src/routes/mcp.ts', import.meta.url), 'utf8');
  assert.ok(!/function deriveAgentIdFromHeaders/.test(mcp), 'alte lokale Funktion steht noch');
  const n = (mcp.match(/leiteAgentIdAusHeaders\(request\.headers/g) ?? []).length;
  assert.equal(n, 2, `erwartet 2 Aufrufe, gefunden ${n}`);
});

console.log(fehler === 0 ? `ALLE OK (${ok})` : `${fehler} FEHLER, ${ok} OK`);
process.exit(fehler === 0 ? 0 : 1);
