process.env.DATABASE_URL = 'postgresql://synapse:synapse2026@192.168.50.65:5432/synapse';

import pg from 'pg';
import { execShellInProject } from './dist/services/shell-exec.js';
import { insertCompletedShellJob, getShellJobs } from './dist/services/shell-queue.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const c = new pg.Client(process.env.DATABASE_URL);
await c.connect();

const r = await execShellInProject({
  project: 'synapse',
  command: 'echo "lokaler-mcp-test"; date',
  timeout_ms: 5000,
  tail_lines: 10,
});
console.log('exec result:', { status: r.status, exit_code: r.exit_code });

const streamId = r.stream_id;
let output;
try { output = fs.readFileSync(path.join(os.homedir(), '.synapse/shell-streams', streamId + '.log'), 'utf8'); } catch {}

const persisted = await insertCompletedShellJob({
  project: 'synapse',
  command: 'echo "lokaler-mcp-test"; date',
  status: r.status === 'done' ? 'done' : 'failed',
  exit_code: r.exit_code,
  tail: r.tail,
  output,
  stream_id: streamId,
  source: 'mcp_local',
});
console.log('persisted id:', persisted.id);

const jobs = await getShellJobs({ project: 'synapse', limit: 3 });
console.log('\nHistory:');
for (const j of jobs) {
  console.log('  ' + j.id.slice(0,8) + ' | claimed_by=' + (j.claimed_by ?? '-') + ' | lines=' + j.output_line_count + ' | ' + j.command.slice(0,50));
}

await c.query('DELETE FROM shell_jobs WHERE id=$1', [persisted.id]);
await c.end();
