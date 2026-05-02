process.env.DATABASE_URL = 'postgresql://synapse:synapse2026@192.168.50.65:5432/synapse';

import pg from 'pg';
import { execShellInProject } from './dist/services/shell-exec.js';
import { insertCompletedShellJob, getShellJobs, enqueueShellJob, waitForShellJob } from './dist/services/shell-queue.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const c = new pg.Client(process.env.DATABASE_URL);
await c.connect();

// 1) Lokaler MCP-Pfad
const r1 = await execShellInProject({ project: 'synapse', command: 'echo MCP-LOCAL-A', timeout_ms: 3000, tail_lines: 5 });
const out1 = fs.readFileSync(path.join(os.homedir(), '.synapse/shell-streams', r1.stream_id + '.log'), 'utf8');
const p1 = await insertCompletedShellJob({ project: 'synapse', command: 'echo MCP-LOCAL-A', status: 'done', exit_code: r1.exit_code, tail: r1.tail, output: out1, stream_id: r1.stream_id, source: 'mcp_local' });
console.log('mcp_local id:', p1.id.slice(0,8));

// 2) Queue-Pfad
const { id: qid } = await enqueueShellJob({ project: 'synapse', command: 'echo QUEUE-B', timeout_ms: 3000, tail_lines: 5 });
const qr = await waitForShellJob(qid, 8000);
console.log('queue id:', qid.slice(0,8), 'status:', qr.status);

// History — beide sichtbar mit source-Trennung
const jobs = await getShellJobs({ project: 'synapse', limit: 4 });
console.log('\nHistory mit source:');
for (const j of jobs) console.log('  ' + j.id.slice(0,8) + ' | source=' + j.source + ' | lines=' + j.output_line_count + ' | ' + j.command.slice(0,40));

// Cleanup
await c.query('DELETE FROM shell_jobs WHERE id IN ($1, $2)', [p1.id, qid]);
await c.end();
