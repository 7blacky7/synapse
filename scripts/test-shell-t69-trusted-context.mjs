/** P10-T69, angepasst P10-T71 Teil 2: Shell-Jobs bekommen KEINE SYNAPSE_SHELL_DB_FREIGABE mehr; die Test-DB oeffnet trotzdem. */
import assert from 'node:assert/strict';
import {oeffneGeschuetzteShellTestDb} from './lib/test-db-schutz.mjs';
const db=await oeffneGeschuetzteShellTestDb();
try {
 await db.query('SELECT 1');
 assert.equal('SYNAPSE_SHELL_DB_FREIGABE' in process.env,false,'P10-T71: keine Freigabe-Metadaten mehr im Job');
 console.log('TEST_DB_OHNE_FREIGABE_OK');
}finally{await db.end();}
