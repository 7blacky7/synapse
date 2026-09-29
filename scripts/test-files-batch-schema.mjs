#!/usr/bin/env node
// test-files-batch-schema.mjs — P7-T11 (d): files_batch(plan_status) lehnte from_line/to_line als unbekannte
// Parameter ab, obwohl die Beschreibung von op_indices sie nennt. files_batch ist nur in der REST-Schema-
// Liste (routes/mcp.ts) definiert. Der plan_status-Handler liest from_line/to_line bereits.
//   - files_batch-Schema hat die Properties from_line + to_line (type number, mit plan_status-Bezug)
//   - files-Schema und files_batch-Schema bieten dieselben plan_status-Parameter (op_index, op_indices, from_line, to_line, wait_seconds)
//   - Handler reicht from_line/to_line an getPlanOpsVollstaendig
// Aufruf: node scripts/test-files-batch-schema.mjs   (Exit 1 bei Fehler)
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

const src = await readFile(new URL('../packages/rest-api/src/routes/mcp.ts', import.meta.url), 'utf8');

/** Schema-Block eines Tools: von "name: '<tool>'," bis zum naechsten Tool ("\n    name: '"). */
function toolBlock(tool) {
  const start = src.indexOf(`name: '${tool}',`);
  assert.ok(start >= 0, `Tool ${tool} nicht gefunden`);
  const rest = src.slice(start + 10);
  const ende = rest.search(/\n {4}name: '/);
  return rest.slice(0, ende > 0 ? ende : undefined);
}

const filesBlock = toolBlock('files');
const batchBlock = toolBlock('files_batch');

await pruefe('files_batch: Property from_line (number)', () => {
  assert.match(batchBlock, /\n\s+from_line: \{ type: 'number'/);
});

await pruefe('files_batch: Property to_line (number)', () => {
  assert.match(batchBlock, /\n\s+to_line: \{ type: 'number'/);
});

await pruefe('files_batch: from_line/to_line-Beschreibung nennt plan_status', () => {
  const m = /\n\s+from_line: \{ type: 'number', description: '([^']*)'/.exec(batchBlock);
  assert.ok(m, 'from_line-Beschreibung fehlt');
  assert.match(m[1], /plan_status/);
});

await pruefe('files und files_batch: gleiche plan_status-Parameter', () => {
  for (const p of ['op_index', 'op_indices', 'from_line', 'to_line', 'wait_seconds', 'plan_id']) {
    assert.match(filesBlock, new RegExp(`\\n\\s+${p}: \\{`), `files: ${p}`);
    assert.match(batchBlock, new RegExp(`\\n\\s+${p}: \\{`), `files_batch: ${p}`);
  }
});

await pruefe('Handler: plan_status reicht from_line/to_line an getPlanOpsVollstaendig', () => {
  assert.match(src, /getPlanOpsVollstaendig\(\{[^}]*from_line: num\(args, 'from_line'\)[^}]*to_line: num\(args, 'to_line'\)/);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
