import {oeffneGeschuetzteShellTestDb} from './lib/test-db-schutz.mjs';
const db=await oeffneGeschuetzteShellTestDb();
try {
 await db.query('SELECT 1');
 const context=JSON.parse(process.env.SYNAPSE_SHELL_DB_FREIGABE);
 console.log('TRUSTED_TEST_SYSTEM_ID '+context.test_system_id);
}finally{await db.end();}
