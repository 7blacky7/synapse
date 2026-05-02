import pg from 'pg';
const c = new pg.Client('postgresql://synapse:synapse2026@192.168.50.65:5432/synapse');
await c.connect();
await c.query('ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS output TEXT');
await c.query('ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS output_truncated BOOLEAN DEFAULT false');
await c.query('CREATE INDEX IF NOT EXISTS idx_shell_jobs_history ON shell_jobs(project, created_at DESC)');
const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='shell_jobs' AND column_name IN ('output','output_truncated')`);
console.log('cols:', cols.rows);
await c.end();
