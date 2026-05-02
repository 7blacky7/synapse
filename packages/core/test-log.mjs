process.env.DATABASE_URL = 'postgresql://synapse:synapse2026@192.168.50.65:5432/synapse';

import pg from 'pg';
import { getShellJobs, getShellJobById, getShellJobLogLines, searchShellJobLog } from './dist/services/shell-queue.js';
const c = new pg.Client(process.env.DATABASE_URL);
await c.connect();

const ins = await c.query(`
  INSERT INTO shell_jobs (project, command, timeout_ms, tail_lines)
  VALUES ('synapse', $1, 5000, 5) RETURNING id`,
  ['for i in 1 2 3 4 5 6 7 8 9 10; do echo "Zeile $i ERROR=$((i*100))"; done; echo "FINAL warning total"; ls /tmp 2>&1 | head -3']);
const id = ins.rows[0].id;
console.log('inserted', id);
await new Promise(r => setTimeout(r, 4000));

console.log('\n=== history ===');
const jobs = await getShellJobs({ project: 'synapse', limit: 3 });
for (const j of jobs) console.log(`${j.id.slice(0,8)} | ${j.status} | lines=${j.output_line_count} | ${j.command.slice(0,50)}`);

console.log('\n=== get ===');
const job = await getShellJobById(id);
console.log('output_line_count:', job?.output_line_count);
console.log('output_truncated:', job?.output_truncated);
console.log('full output:\n  ' + (job?.output ?? '').split('\n').join('\n  '));

console.log('\n=== log lines 3-6 ===');
console.log(await getShellJobLogLines(id, 3, 6));

console.log('\n=== search "ERROR=500" (substring) ===');
console.log(await searchShellJobLog(id, 'ERROR=500'));

console.log('\n=== search regex ===');
const s2 = await searchShellJobLog(id, 'ERROR=\\d00$', { regex: true });
console.log(`total_matches=${s2.total_matches}, total_lines=${s2.total_lines}, sample:`, s2.matches.slice(0,3));

console.log('\n=== search "700" (int as substring) ===');
console.log(await searchShellJobLog(id, '700'));

await c.query('DELETE FROM shell_jobs WHERE id=$1', [id]);
await c.end();
