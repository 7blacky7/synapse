/** P10-T65: echte DROP-Probe nur mit gemeinsamem Laufzeitguard. */
import {oeffneGeschuetzteShellTestDb} from '../../../../scripts/lib/test-db-schutz.mjs';
const db=await oeffneGeschuetzteShellTestDb();
try{
  const schema=process.argv[2];
  if(!/^p10_t65_[0-9]+$/.test(schema??''))throw Error('eigener_testbereich_erforderlich');
  await db.query('DROP SCHEMA '+schema+' CASCADE');
}finally{await db.end();}
