/** P20-R1.2/T9: alle Queries bleiben hinter dem geprüften D1-Laufzeitclient. */
import assert from 'node:assert/strict';
import {oeffneGeschuetzteShellTestDb} from './lib/test-db-schutz.mjs';
import {runComputePolicyProbe} from './lib/compute-policy-probe.mjs';
const raw=new URL(process.env.DATABASE_URL??'');
assert.equal(raw.port,'5433'); assert.equal(raw.pathname,'/synapse_test');
raw.searchParams.set('options','-c search_path=p20_r12,public');
const db=await oeffneGeschuetzteShellTestDb(raw.href);
try {
  assert.equal((await db.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
  await runComputePolicyProbe(db,process.argv[2]??'verify');
} finally {await db.end();}
