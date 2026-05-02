import pg from 'pg';
const c = new pg.Client('postgresql://synapse:synapse2026@192.168.50.65:5432/synapse');
await c.connect();

// 1) Insert ein Job mit Multi-Line Command
const ins = await c.query(`
  INSERT INTO shell_jobs (project, command, timeout_ms, tail_lines)
  VALUES ('synapse', $1, 5000, 5) RETURNING id`,
  ['echo "line1"\necho "line2"\necho "line3"\nls -la /tmp | head -3']);
const id = ins.rows[0].id;
console.log('[t=0]   inserted', id);

// 2) Wait for done
let done = false;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 500));
  const f = await c.query(`SELECT status, exit_code, error FROM shell_jobs WHERE id=$1`, [id]);
  if (['done','failed','rejected','timeout'].includes(f.rows[0].status)) {
    console.log(`[t=${i*0.5}s] done: status=${f.rows[0].status} exit=${f.rows[0].exit_code}`);
    done = true; break;
  }
}

// 3) Read full row inkl. output
const r = await c.query(`SELECT status, exit_code, tail, output, output_truncated FROM shell_jobs WHERE id=$1`, [id]);
const row = r.rows[0];
console.log('Status:', row.status);
console.log('Exit:', row.exit_code);
console.log('Tail (last N):', JSON.stringify(row.tail));
console.log('Output stored:', row.output ? row.output.length + ' bytes' : '(null)');
console.log('Truncated:', row.output_truncated);
console.log('Output content:');
console.log('  ' + (row.output ?? '').split('\n').join('\n  '));

// 4) cleanup
await c.query('DELETE FROM shell_jobs WHERE id=$1', [id]);
await c.end();
